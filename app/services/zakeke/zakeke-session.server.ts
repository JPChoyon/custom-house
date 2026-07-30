import { randomUUID } from "node:crypto";
import db from "../../db.server";
import { DomainError, normalizeHttpsUrl, safeJson } from "../domain";
import { requireApprovedCreator } from "../designer-session.server";
import { normalizeCustomerGid } from "../helium-sync.server";
import type { ShopifyGraphqlClient } from "../shopify-graphql.server";
import { ZakekeAuthService } from "./zakeke-auth.server";
import { getZakekeFeatureFlags } from "./zakeke-config.server";
import { ZakekeDesignService } from "./zakeke-designs.server";
import {
  requireActiveGlobalProductMapping,
  requireMappedVariant,
  verifyGlobalZakekeProduct,
} from "./zakeke-products.server";
import {
  hashOpaqueValue,
  newZakekeNonce,
  signDesignPurchaseToken,
  signZakekeDesignerSession,
  verifyZakekeDesignerSession,
} from "./zakeke-signing.server";
import { zakekeIdentityForPrincipal } from "./zakeke-identity";
export { zakekeIdentityForPrincipal } from "./zakeke-identity";

function safeIntent(value: string | null) {
  if (!value || value === "customer") return "CUSTOMER_BUY" as const;
  if (value === "creator") return "CREATOR_PUBLISH" as const;
  throw new DomainError(
    "DESIGNER_MODE_INVALID",
    "The requested designer mode is invalid.",
    400,
  );
}

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

function safeCallbackJson(value: unknown) {
  const text = JSON.stringify(value ?? []);
  if (text.length > 32_000) {
    throw new DomainError(
      "ZAKEKE_CALLBACK_INVALID",
      "The customization data is too large.",
      422,
    );
  }
  return text;
}

function safeDesignId(value: unknown) {
  const designId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/.test(designId)) {
    throw new DomainError(
      "ZAKEKE_DESIGN_INVALID",
      "The customization design is invalid.",
      422,
    );
  }
  return designId;
}

function safeQuantity(value: unknown) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new DomainError(
      "ZAKEKE_QUANTITY_INVALID",
      "Choose a quantity between 1 and 100.",
      422,
    );
  }
  return quantity;
}

export async function createZakekeDesignerSession(input: {
  shop: string;
  customerId: string | null;
  productId: string;
  variantId: string;
  intent: string | null;
  client: ShopifyGraphqlClient;
  auth?: ZakekeAuthService;
}) {
  const flags = getZakekeFeatureFlags();
  if (!flags.integration) {
    throw new DomainError(
      "ZAKEKE_DISABLED",
      "Product customization is not available.",
      404,
    );
  }
  const mode = safeIntent(input.intent);
  const mapping = await requireActiveGlobalProductMapping(
    input.shop,
    input.productId,
  );
  const mappedVariant = requireMappedVariant(
    mapping.variantMapping,
    input.variantId,
  );
  const product = await verifyGlobalZakekeProduct(
    input.client,
    input.productId,
  );
  const productVariant = product.variants.find(
    (variant) => variant.id === input.variantId,
  );
  if (!productVariant?.availableForSale) {
    throw new DomainError(
      "ZAKEKE_VARIANT_UNAVAILABLE",
      "The selected product option is unavailable.",
      409,
    );
  }
  if (productVariant.sku && productVariant.sku !== mappedVariant.sku) {
    throw new DomainError(
      "ZAKEKE_MAPPING_STALE",
      "The Zakeke variant mapping needs to be synchronized.",
      409,
    );
  }

  let creatorId: string | undefined;
  let principal: string;
  if (input.customerId) {
    principal = normalizeCustomerGid(input.customerId);
    if (mode === "CREATOR_PUBLISH") {
      if (!flags.creatorPublishing) {
        throw new DomainError(
          "ZAKEKE_CREATOR_PUBLISHING_DISABLED",
          "Creator publishing is not enabled.",
          404,
        );
      }
      const creator = await requireApprovedCreator(input.shop, principal);
      creatorId = creator.id;
    }
  } else {
    if (mode === "CREATOR_PUBLISH") {
      throw new DomainError(
        "LOGIN_REQUIRED",
        "Sign in before adding a design to your collection.",
        401,
      );
    }
    principal = `visitor:${randomUUID().replaceAll("-", "")}`;
  }

  const identity = zakekeIdentityForPrincipal(principal);
  const c2sToken = await (input.auth ?? new ZakekeAuthService()).getC2SToken(
    identity,
  );
  const nonce = newZakekeNonce();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const session = await db.designSession.create({
    data: {
      shop: input.shop,
      customerId: principal,
      creatorId,
      clientKey: randomUUID().replaceAll("-", ""),
      shopifyProductId: input.productId,
      shopifyVariantId: input.variantId,
      mode,
      provider: "ZAKEKE",
      visitorCode: identity.visitorCode,
      nonceHash: hashOpaqueValue(nonce),
      expiresAt,
      selectedAttributesJson: JSON.stringify(mappedVariant.attributes),
      globalProductMappingId: mapping.id,
      designJson: "{}",
      status: "READY",
    },
  });
  const sessionToken = signZakekeDesignerSession({
    sessionId: session.id,
    shop: input.shop,
    productId: input.productId,
    variantId: input.variantId,
    mode,
    principal,
    creatorId,
    nonce,
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
  });
  return {
    sessionToken,
    tokenOauth: c2sToken.accessToken,
    expiresAt: expiresAt.toISOString(),
    mode,
    product: {
      id: mapping.zakekeProductCode,
      shopifyProductId: input.productId,
      title: product.title,
      variantId: input.variantId,
      sku: mappedVariant.sku,
      price: Number(productVariant.price),
      attributes: mappedVariant.attributes,
    },
  };
}

export async function verifyZakekeCallback(input: {
  shop: string;
  customerId: string | null;
  sessionToken: string;
  designId: unknown;
  quantity: unknown;
  selectedAttributes: unknown;
  designService?: ZakekeDesignService;
}) {
  const payload = verifyZakekeDesignerSession(input.sessionToken);
  if (payload.shop !== input.shop) {
    throw new DomainError(
      "DESIGNER_SESSION_INVALID",
      "The designer session is invalid.",
      401,
    );
  }
  const currentPrincipal = input.customerId
    ? normalizeCustomerGid(input.customerId)
    : payload.principal;
  if (payload.principal !== currentPrincipal) {
    throw new DomainError(
      "DESIGNER_SESSION_FORBIDDEN",
      "This designer session belongs to another customer.",
      403,
    );
  }
  const session = await db.designSession.findFirst({
    where: {
      id: payload.sessionId,
      shop: input.shop,
      provider: "ZAKEKE",
      customerId: payload.principal,
      shopifyProductId: payload.productId,
      shopifyVariantId: payload.variantId,
    },
    include: { globalProductMapping: true },
  });
  if (
    !session ||
    !session.globalProductMapping ||
    !session.expiresAt ||
    session.expiresAt.getTime() < Date.now() ||
    session.nonceHash !== hashOpaqueValue(payload.nonce)
  ) {
    throw new DomainError(
      "DESIGNER_SESSION_EXPIRED",
      "This designer session has expired. Start again.",
      401,
    );
  }
  const designId = safeDesignId(input.designId);
  const quantity = safeQuantity(input.quantity);
  const selectedAttributesJson = safeCallbackJson(input.selectedAttributes);
  const identity = zakekeIdentityForPrincipal(payload.principal);
  const design = await (
    input.designService ?? new ZakekeDesignService()
  ).getDesign(designId, quantity, identity);
  if (
    design.designID !== designId ||
    design.modelCode !== session.globalProductMapping.zakekeProductCode ||
    (design.customerCode &&
      identity.customerCode &&
      design.customerCode !== identity.customerCode) ||
    (design.visitorCode &&
      identity.visitorCode &&
      design.visitorCode !== identity.visitorCode)
  ) {
    throw new DomainError(
      "ZAKEKE_DESIGN_FORBIDDEN",
      "This design does not belong to the current product and customer.",
      403,
    );
  }
  const preview = design.previewimageurl || design.previewFiles?.[0]?.url;
  if (!preview) {
    throw new DomainError(
      "ZAKEKE_PREVIEW_MISSING",
      "Zakeke has not generated the design preview yet.",
      409,
    );
  }
  const previewUrl = normalizeHttpsUrl(preview);
  await db.designSession.update({
    where: { id: session.id },
    data: {
      zakekeDesignId: designId,
      previewUrl,
      artworkUrl: previewUrl,
      selectedAttributesJson,
      designJson: safeJson({
        provider: "ZAKEKE",
        designId,
        modelCode: design.modelCode,
      }),
    },
  });
  return {
    payload,
    session,
    design,
    designId,
    quantity,
    previewUrl,
    selectedAttributesJson,
    identity,
  };
}

export async function createCustomerDesignPurchase(input: {
  shop: string;
  verified: Awaited<ReturnType<typeof verifyZakekeCallback>>;
}) {
  const { payload, session, designId, quantity } = input.verified;
  if (payload.mode !== "CUSTOMER_BUY") {
    throw new DomainError(
      "DESIGNER_MODE_INVALID",
      "This designer session cannot add a customer cart line.",
      409,
    );
  }
  const idempotencyKey = hashOpaqueValue(
    [input.shop, session.id, designId, payload.variantId].join(":"),
  );
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  let purchase = await db.designPurchase.findUnique({
    where: {
      shop_idempotencyKey: { shop: input.shop, idempotencyKey },
    },
  });
  if (!purchase) {
    purchase = await db.designPurchase.create({
      data: {
        shop: input.shop,
        sourceZakekeDesignId: designId,
        purchaseZakekeDesignId: designId,
        shopifyProductId: payload.productId,
        shopifyVariantId: payload.variantId,
        customerId: payload.principal.startsWith("gid://")
          ? payload.principal
          : null,
        visitorCode: session.visitorCode,
        idempotencyKey,
        status: "READY",
        expiresAt,
      },
    });
  }
  const token = signDesignPurchaseToken({
    purchaseId: purchase.id,
    shop: input.shop,
    productId: purchase.shopifyProductId,
    variantId: purchase.shopifyVariantId,
    principal: payload.principal,
    expiresAt: Math.floor(purchase.expiresAt.getTime() / 1000),
  });
  const tokenHash = hashOpaqueValue(token);
  if (purchase.signedTokenHash !== tokenHash || purchase.status !== "READY") {
    purchase = await db.designPurchase.update({
      where: { id: purchase.id },
      data: { signedTokenHash: tokenHash, status: "READY" },
    });
  }
  await db.designSession.update({
    where: { id: session.id },
    data: { status: "CARTED" },
  });
  return {
    purchaseId: purchase.id,
    cart: {
      id: numericVariantId(payload.variantId),
      quantity,
      properties: {
        _custom_house_mode: "customer_customized",
        _custom_house_design_id: designId,
        _custom_house_purchase_id: purchase.id,
        _custom_house_design_token: token,
      },
    },
  };
}
