import { randomUUID } from "node:crypto";
import db from "../../db.server";
import { DomainError, parseJsonList } from "../domain";
import { normalizeCustomerGid } from "../helium-sync.server";
import type { ShopifyGraphqlClient } from "../shopify-graphql.server";
import { getZakekeFeatureFlags } from "./zakeke-config.server";
import { canCreatorPublish } from "../designer-publishing";
import { ZakekeDesignService } from "./zakeke-designs.server";
import {
  hashOpaqueValue,
  signDesignPurchaseToken,
} from "./zakeke-signing.server";
import { zakekeIdentityForPrincipal } from "./zakeke-session.server";

function numericVariantId(value: string) {
  const id = value.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/)?.[1];
  if (!id) {
    throw new DomainError(
      "VARIANT_INVALID",
      "The selected product option is invalid.",
      422,
    );
  }
  return id;
}

function safeIdempotencyKey(value: string) {
  const key = value.trim();
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(key)) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_INVALID",
      "Start the purchase again.",
      422,
    );
  }
  return key;
}

async function verifyFixedShopifyVariant(
  client: ShopifyGraphqlClient,
  productId: string,
  variantId: string,
) {
  const result = await client.request<{
    product: {
      id: string;
      status: string;
      variants: {
        nodes: Array<{ id: string; availableForSale: boolean }>;
      };
    } | null;
  }>(
    `#graphql query FixedCreatorPurchaseProduct($id: ID!) {
      product(id: $id) {
        id
        status
        variants(first: 100) { nodes { id availableForSale } }
      }
    }`,
    { id: productId },
  );
  const variant = result.product?.variants.nodes.find(
    (item) => item.id === variantId,
  );
  if (result.product?.status !== "ACTIVE" || !variant?.availableForSale) {
    throw new DomainError(
      "CREATOR_PRODUCT_UNAVAILABLE",
      "This creator product option is unavailable.",
      409,
    );
  }
}

function cartResult(input: {
  purchase: {
    id: string;
    shop: string;
    shopifyProductId: string;
    shopifyVariantId: string;
    purchaseZakekeDesignId: string | null;
    expiresAt: Date;
  };
  creatorDesignId: string;
  principal: string;
  quantity: number;
}) {
  if (!input.purchase.purchaseZakekeDesignId) {
    throw new DomainError(
      "ZAKEKE_DESIGN_DUPLICATION_FAILED",
      "We could not prepare this design for purchase. Please try again.",
      502,
    );
  }
  const token = signDesignPurchaseToken({
    purchaseId: input.purchase.id,
    shop: input.purchase.shop,
    productId: input.purchase.shopifyProductId,
    variantId: input.purchase.shopifyVariantId,
    principal: input.principal,
    expiresAt: Math.floor(input.purchase.expiresAt.getTime() / 1000),
  });
  return {
    token,
    tokenHash: hashOpaqueValue(token),
    cart: {
      id: numericVariantId(input.purchase.shopifyVariantId),
      quantity: input.quantity,
      properties: {
        _custom_house_mode: "creator_fixed",
        _custom_house_creator_design_id: input.creatorDesignId,
        _custom_house_zakeke_design_id:
          input.purchase.purchaseZakekeDesignId,
        _custom_house_purchase_id: input.purchase.id,
        _custom_house_purchase_token: token,
      },
    },
  };
}

export async function prepareFixedCreatorPurchase(input: {
  shop: string;
  customerId: string | null;
  creatorDesignId: string;
  variantId: string;
  quantity: number;
  idempotencyKey: string;
  client: ShopifyGraphqlClient;
  designService?: ZakekeDesignService;
}) {
  if (!getZakekeFeatureFlags().fixedPurchase) {
    throw new DomainError(
      "ZAKEKE_FIXED_PURCHASE_DISABLED",
      "Fixed creator design purchase is not enabled.",
      404,
    );
  }
  if (
    !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(input.variantId) ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 100
  ) {
    throw new DomainError(
      "CREATOR_PURCHASE_INVALID",
      "Choose a valid product option and quantity.",
      422,
    );
  }
  const requestKey = safeIdempotencyKey(input.idempotencyKey);
  const design = await db.creatorDesign.findFirst({
    where: {
      id: input.creatorDesignId,
      shop: input.shop,
      provider: "ZAKEKE",
      status: "ACTIVE",
      syncStatus: "SYNCED",
      hiddenReason: null,
      sourceZakekeDesignId: { not: null },
      shopifyCreatorProductId: { not: null },
      shopifyCollectionId: { not: null },
    },
    include: { creator: true },
  });
  if (
    !design?.sourceZakekeDesignId ||
    !design.shopifyCreatorProductId ||
    !canCreatorPublish(design.creator.status, design.creator.suspendedAt)
  ) {
    throw new DomainError(
      "CREATOR_DESIGN_UNAVAILABLE",
      "This creator design is unavailable.",
      404,
    );
  }
  const compatible = parseJsonList(design.compatibleVariantIdsJson);
  if (!compatible.includes(input.variantId)) {
    throw new DomainError(
      "ZAKEKE_VARIANT_INCOMPATIBLE",
      "This product option has not passed design compatibility testing.",
      409,
    );
  }
  await verifyFixedShopifyVariant(
    input.client,
    design.shopifyCreatorProductId,
    input.variantId,
  );

  const customerPrincipal = input.customerId
    ? normalizeCustomerGid(input.customerId)
    : null;
  const idempotencyKey = hashOpaqueValue(
    [
      input.shop,
      design.id,
      input.variantId,
      customerPrincipal || "guest",
      requestKey,
    ].join(":"),
  );
  const existing = await db.designPurchase.findUnique({
    where: {
      shop_idempotencyKey: { shop: input.shop, idempotencyKey },
    },
  });
  if (
    existing?.status === "READY" &&
    existing.purchaseZakekeDesignId &&
    existing.expiresAt.getTime() > Date.now()
  ) {
    const principal =
      existing.customerId ||
      (existing.visitorCode ? `visitor:${existing.visitorCode}` : "");
    const result = cartResult({
      purchase: existing,
      creatorDesignId: design.id,
      principal,
      quantity: input.quantity,
    });
    if (existing.signedTokenHash !== result.tokenHash) {
      await db.designPurchase.update({
        where: { id: existing.id },
        data: { signedTokenHash: result.tokenHash },
      });
    }
    return { purchaseId: existing.id, cart: result.cart };
  }
  if (existing?.status === "CREATING") {
    throw new DomainError(
      "DESIGN_PURCHASE_IN_PROGRESS",
      "This design purchase is already being prepared.",
      409,
    );
  }

  const visitorCode = customerPrincipal
    ? null
    : randomUUID().replaceAll("-", "");
  const principal =
    customerPrincipal || `visitor:${visitorCode as string}`;
  let purchase;
  try {
    purchase = await db.designPurchase.create({
      data: {
        shop: input.shop,
        creatorDesignId: design.id,
        sourceZakekeDesignId: design.sourceZakekeDesignId,
        shopifyProductId: design.shopifyCreatorProductId,
        shopifyVariantId: input.variantId,
        customerId: customerPrincipal,
        visitorCode,
        idempotencyKey,
        status: "CREATING",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
  } catch {
    throw new DomainError(
      "DESIGN_PURCHASE_IN_PROGRESS",
      "This design purchase is already being prepared.",
      409,
    );
  }
  try {
    const duplicate = await (
      input.designService ?? new ZakekeDesignService()
    ).duplicateDesign(
      design.sourceZakekeDesignId,
      zakekeIdentityForPrincipal(principal),
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/.test(duplicate.id)) {
      throw new DomainError(
        "ZAKEKE_DESIGN_DUPLICATION_FAILED",
        "We could not prepare this design for purchase. Please try again.",
        502,
      );
    }
    purchase = await db.designPurchase.update({
      where: { id: purchase.id },
      data: {
        purchaseZakekeDesignId: duplicate.id,
        status: "READY",
      },
    });
    const result = cartResult({
      purchase,
      creatorDesignId: design.id,
      principal,
      quantity: input.quantity,
    });
    await db.designPurchase.update({
      where: { id: purchase.id },
      data: { signedTokenHash: result.tokenHash },
    });
    return { purchaseId: purchase.id, cart: result.cart };
  } catch (error) {
    await db.designPurchase.update({
      where: { id: purchase.id },
      data: { status: "FAILED" },
    });
    throw error;
  }
}
