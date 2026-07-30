import { randomUUID } from "node:crypto";
import db from "../../db.server";
import { DomainError, safeJson } from "../domain";
import {
  hashOpaqueValue,
  verifyDesignPurchaseToken,
} from "./zakeke-signing.server";
import { ZakekeOrderService } from "./zakeke-orders.server";
import { ZakekeDesignService } from "./zakeke-designs.server";
import { ZakekeError } from "./zakeke-errors.server";
import { zakekeIdentityForPrincipal } from "./zakeke-session.server";
import type {
  RegisterZakekeOrderDetail,
  RegisterZakekeOrderInput,
} from "./zakeke-types";

type WebhookProperty = { name?: string; value?: string };
type ShopifyOrderLine = {
  id?: number | string;
  product_id?: number | string;
  variant_id?: number | string;
  sku?: string | null;
  quantity?: number;
  price?: string | number;
  properties?: WebhookProperty[];
};

type ShopifyOrderPayload = {
  id?: number | string;
  name?: string;
  created_at?: string;
  total_price?: string | number;
  customer?: { id?: number | string } | null;
  line_items?: ShopifyOrderLine[];
};

function properties(line: ShopifyOrderLine) {
  return new Map(
    (Array.isArray(line.properties) ? line.properties : [])
      .filter(
        (item): item is Required<WebhookProperty> =>
          typeof item?.name === "string" &&
          typeof item?.value === "string",
      )
      .map((item) => [item.name, item.value]),
  );
}

function gid(type: "Order" | "Product" | "ProductVariant", value: unknown) {
  const id = String(value ?? "");
  if (!/^\d+$/.test(id)) {
    throw new DomainError(
      "SHOPIFY_WEBHOOK_INVALID",
      "The Shopify webhook payload is invalid.",
      422,
    );
  }
  return `gid://shopify/${type}/${id}`;
}

async function verifiedPurchaseFromLine(
  shop: string,
  orderCustomerId: string | null,
  line: ShopifyOrderLine,
) {
  const values = properties(line);
  const purchaseId = values.get("_custom_house_purchase_id");
  const token =
    values.get("_custom_house_purchase_token") ||
    values.get("_custom_house_design_token");
  const designId =
    values.get("_custom_house_zakeke_design_id") ||
    values.get("_custom_house_design_id");
  const mode = values.get("_custom_house_mode");
  if (!purchaseId && !token && !designId && !mode) return null;
  if (!purchaseId || !token || !designId) {
    throw new DomainError(
      "CUSTOMIZED_LINE_INVALID",
      "A customized order line is missing its verified reference.",
      422,
    );
  }
  // Shopify checkout can complete after the short-lived storefront token has
  // expired. The webhook still requires the original valid HMAC plus an exact
  // immutable database match, so expiry is intentionally ignored only here.
  const payload = verifyDesignPurchaseToken(token, { allowExpired: true });
  const purchase = await db.designPurchase.findFirst({
    where: { id: purchaseId, shop },
    include: {
      creatorDesign: {
        include: { creator: true },
      },
    },
  });
  if (
    !purchase ||
    purchase.signedTokenHash !== hashOpaqueValue(token) ||
    payload.purchaseId !== purchase.id ||
    payload.shop !== shop ||
    payload.productId !== gid("Product", line.product_id) ||
    payload.variantId !== gid("ProductVariant", line.variant_id) ||
    purchase.shopifyProductId !== payload.productId ||
    purchase.shopifyVariantId !== payload.variantId ||
    purchase.purchaseZakekeDesignId !== designId ||
    !["READY", "CARTED", "ORDERED"].includes(purchase.status) ||
    (purchase.customerId &&
      (!orderCustomerId ||
        purchase.customerId !== orderCustomerId ||
        payload.principal !== orderCustomerId)) ||
    (!purchase.customerId &&
      (!purchase.visitorCode ||
        payload.principal !== `visitor:${purchase.visitorCode}`))
  ) {
    throw new DomainError(
      "CUSTOMIZED_LINE_FORBIDDEN",
      "A customized order line could not be verified.",
      403,
    );
  }
  return { purchase, payload, line, mode, designId };
}

type VerifiedPurchaseLine = NonNullable<
  Awaited<ReturnType<typeof verifiedPurchaseFromLine>>
>;

export async function queueZakekeOrder(input: {
  shop: string;
  webhookId: string;
  topic: string;
  payload: ShopifyOrderPayload;
}) {
  const orderId = gid("Order", input.payload.id);
  const orderCustomerId = input.payload.customer?.id
    ? `gid://shopify/Customer/${String(input.payload.customer.id)}`
    : null;
  const verified: VerifiedPurchaseLine[] = [];
  for (const line of input.payload.line_items || []) {
    const item = await verifiedPurchaseFromLine(
      input.shop,
      orderCustomerId,
      line,
    );
    if (item) verified.push(item);
  }
  const claimed = await db.webhookDelivery.upsert({
    where: {
      shop_webhookId: {
        shop: input.shop,
        webhookId: input.webhookId,
      },
    },
    create: {
      shop: input.shop,
      webhookId: input.webhookId,
      topic: input.topic,
    },
    update: { attempts: { increment: 1 } },
  });
  if (claimed.status === "COMPLETED") {
    return { duplicate: true, customizedLines: verified.length };
  }
  if (!verified.length) {
    await db.webhookDelivery.update({
      where: { id: claimed.id },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
    return { duplicate: false, customizedLines: 0 };
  }

  const details: RegisterZakekeOrderDetail[] = verified.map((item) => ({
    orderDetailCode: String(item.line.id),
    sku: String(item.line.sku || ""),
    designID: item.designId,
    modelUnitPrice: Number(item.line.price || 0),
    designUnitPrice: 0,
    quantity: Number(item.line.quantity || 1),
  }));
  const orderInput: RegisterZakekeOrderInput = {
    orderCode: String(input.payload.name || input.payload.id),
    orderDate:
      typeof input.payload.created_at === "string"
        ? input.payload.created_at
        : new Date().toISOString(),
    sessionID: orderId,
    total: Number(input.payload.total_price || 0),
    details,
  };
  const first = verified[0].purchase;
  const customerId = orderCustomerId || first.customerId;
  const visitorCode = customerId ? null : first.visitorCode;
  const job = await db.$transaction(async (tx) => {
    const queued = await tx.zakekeOrderJob.upsert({
      where: {
        shop_shopifyOrderId: { shop: input.shop, shopifyOrderId: orderId },
      },
      create: {
        shop: input.shop,
        shopifyOrderId: orderId,
        shopifyOrderCode: orderInput.orderCode,
        customerId,
        visitorCode,
        payloadJson: safeJson(orderInput),
      },
      update: {},
    });
    for (const item of verified) {
      const design = item.purchase.creatorDesign;
      await tx.orderDesignSnapshot.upsert({
        where: {
          shop_shopifyLineItemId: {
            shop: input.shop,
            shopifyLineItemId: String(item.line.id),
          },
        },
        create: {
          shop: input.shop,
          shopifyOrderId: orderId,
          shopifyLineItemId: String(item.line.id),
          creatorId: design?.creatorId,
          creatorDesignId: design?.id,
          sourceShopifyProductId:
            design?.globalShopifyProductId ||
            item.purchase.shopifyProductId,
          shopifyCreatorProductId:
            design?.shopifyCreatorProductId || null,
          shopifyVariantId: item.purchase.shopifyVariantId,
          sourceZakekeDesignId: item.purchase.sourceZakekeDesignId,
          orderZakekeDesignId: item.designId,
          designVersion: design?.designVersion || 1,
          previewUrl: design?.previewUrl,
          designTitle: design?.title || "Customer customization",
          creatorName: design?.creator.displayName,
        },
        update: {},
      });
    }
    return queued;
  });
  return {
    duplicate: false,
    customizedLines: verified.length,
    jobId: job.id,
    deliveryId: claimed.id,
  };
}

export async function processZakekeOrderJob(
  jobId: string,
  orderService = new ZakekeOrderService(),
) {
  const claimed = await db.zakekeOrderJob.updateMany({
    where: {
      id: jobId,
      status: { in: ["PENDING", "FAILED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    return db.zakekeOrderJob.findUnique({ where: { id: jobId } });
  }
  const job = await db.zakekeOrderJob.findUniqueOrThrow({
    where: { id: jobId },
  });
  const order = JSON.parse(job.payloadJson) as RegisterZakekeOrderInput;
  const principal =
    job.customerId ||
    (job.visitorCode ? `visitor:${job.visitorCode}` : null);
  if (!principal) {
    throw new DomainError(
      "ZAKEKE_ORDER_IDENTITY_MISSING",
      "The customized order identity is missing.",
      409,
    );
  }
  try {
    await orderService.registerOrder(
      order,
      zakekeIdentityForPrincipal(principal),
    );
    return await db.$transaction(async (tx) => {
      const updated = await tx.zakekeOrderJob.update({
        where: { id: job.id },
        data: {
          status: "REGISTERED",
          registeredAt: new Date(),
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorReference: null,
        },
      });
      await tx.designPurchase.updateMany({
        where: {
          shop: job.shop,
          purchaseZakekeDesignId: {
            in: order.details.map((item) => item.designID),
          },
        },
        data: { status: "ORDERED" },
      });
      await tx.orderDesignSnapshot.updateMany({
        where: { shop: job.shop, shopifyOrderId: job.shopifyOrderId },
        data: { printFilesStatus: "PROCESSING" },
      });
      return updated;
    });
  } catch (error) {
    const referenceId =
      error instanceof ZakekeError ? error.referenceId : randomUUID();
    const errorCode =
      error instanceof DomainError
        ? error.code
        : "ZAKEKE_ORDER_REGISTRATION_FAILED";
    const delayMinutes = Math.min(60, 2 ** Math.min(job.attempts, 5));
    await db.zakekeOrderJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        lastErrorCode: errorCode,
        lastErrorReference: referenceId,
        nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
      },
    });
    throw error;
  }
}

export async function markZakekeOrderState(input: {
  shop: string;
  shopifyOrderId: string;
  state: "CANCELLED" | "REFUNDED";
}) {
  await db.$transaction([
    db.zakekeOrderJob.updateMany({
      where: {
        shop: input.shop,
        shopifyOrderId: input.shopifyOrderId,
      },
      data: { status: input.state },
    }),
    db.orderDesignSnapshot.updateMany({
      where: {
        shop: input.shop,
        shopifyOrderId: input.shopifyOrderId,
      },
      data: { printFilesStatus: input.state },
    }),
  ]);
}

export async function refreshZakekePrintFiles(
  jobId: string,
  designService = new ZakekeDesignService(),
) {
  const job = await db.zakekeOrderJob.findUnique({
    where: { id: jobId },
  });
  if (!job || job.status !== "REGISTERED") {
    throw new DomainError(
      "ZAKEKE_ORDER_NOT_REGISTERED",
      "Register the Zakeke order before retrieving print files.",
      409,
    );
  }
  const principal =
    job.customerId ||
    (job.visitorCode ? `visitor:${job.visitorCode}` : null);
  if (!principal) {
    throw new DomainError(
      "ZAKEKE_ORDER_IDENTITY_MISSING",
      "The customized order identity is missing.",
      409,
    );
  }
  const snapshots = await db.orderDesignSnapshot.findMany({
    where: { shop: job.shop, shopifyOrderId: job.shopifyOrderId },
  });
  let available = 0;
  let pending = 0;
  for (const snapshot of snapshots) {
    try {
      const output = await designService.getOutputFiles(
        snapshot.orderZakekeDesignId,
        zakekeIdentityForPrincipal(principal),
      );
      const url = new URL(output.url);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new DomainError(
          "ZAKEKE_PRINT_FILE_INVALID",
          "Zakeke returned an invalid print-file reference.",
          502,
        );
      }
      await db.orderDesignSnapshot.update({
        where: { id: snapshot.id },
        data: {
          printFilesStatus: "AVAILABLE",
          printFilesReference: url.toString(),
        },
      });
      available += 1;
    } catch {
      await db.orderDesignSnapshot.update({
        where: { id: snapshot.id },
        data: { printFilesStatus: "PROCESSING" },
      });
      pending += 1;
    }
  }
  return { available, pending, total: snapshots.length };
}
