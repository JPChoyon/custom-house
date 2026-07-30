import type {
  DesignSession,
  DesignSessionStatus,
  DesignerMode,
} from "@prisma/client";
import db from "../db.server";
import { DomainError } from "./domain";
import type { DesignerProductConfig } from "./designer-config.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { normalizeCustomerGid } from "./helium-sync.server";
import { validateDesignJson } from "./designer-validation";
import { canCreatorPublish } from "./designer-publishing";

export type VerifiedDesignerProduct = {
  id: string;
  title: string;
  tags: string[];
  variants: Array<{
    id: string;
    availableForSale: boolean;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
  variant: {
    id: string;
    availableForSale: boolean;
    selectedOptions: Array<{ name: string; value: string }>;
  };
};

export async function verifyDesignerProduct(
  client: ShopifyGraphqlClient,
  config: DesignerProductConfig,
  productId: string,
  variantId: string,
): Promise<VerifiedDesignerProduct> {
  if (productId !== config.shopifyProductId) {
    throw new DomainError(
      "PRODUCT_NOT_ALLOWED",
      "This product is not available in the customizer.",
      422,
    );
  }
  if (
    !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId) ||
    (config.allowedVariantIds.length > 0 &&
      !config.allowedVariantIds.includes(variantId))
  ) {
    throw new DomainError(
      "VARIANT_NOT_ALLOWED",
      "Choose an available product option.",
      422,
    );
  }
  const result = await client.request<{
    product: {
      id: string;
      title: string;
      tags: string[];
      status: string;
      origin: { value: string } | null;
      mode: { value: string } | null;
      variants: {
        nodes: Array<{
          id: string;
          availableForSale: boolean;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
      };
    } | null;
  }>(
    `#graphql query DesignerProduct($id: ID!) {
      product(id: $id) {
        id
        title
        tags
        status
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        mode: metafield(namespace: "customhouse", key: "design_mode") { value }
        variants(first: 100) {
          nodes { id availableForSale selectedOptions { name value } }
        }
      }
    }`,
    { id: productId },
  );
  const product = result.product;
  if (
    !product ||
    product.status !== "ACTIVE" ||
    product.origin?.value !== "global" ||
    product.mode?.value !== "customizable"
  ) {
    throw new DomainError(
      "PRODUCT_UNAVAILABLE",
      "This product is not currently available for customization.",
      409,
    );
  }
  const variant = product.variants.nodes.find((item) => item.id === variantId);
  if (!variant?.availableForSale) {
    throw new DomainError(
      "VARIANT_UNAVAILABLE",
      "The selected product option is unavailable.",
      409,
    );
  }
  return {
    id: product.id,
    title: product.title,
    tags: product.tags,
    variants: product.variants.nodes,
    variant,
  };
}

export async function requireApprovedCreator(shop: string, customerId: string) {
  const creator = await db.creator.findUnique({
    where: {
      shop_customerId: {
        shop,
        customerId: normalizeCustomerGid(customerId),
      },
    },
  });
  if (!creator || !canCreatorPublish(creator.status, creator.suspendedAt)) {
    throw new DomainError(
      "CREATOR_FORBIDDEN",
      "Only approved, active creators can publish designs.",
      403,
    );
  }
  return creator;
}

export async function assertDesignSessionVersion(input: {
  shop: string;
  customerId: string;
  sessionId?: string;
  expectedVersion: number;
}) {
  if (!input.sessionId) return null;
  const session = await db.designSession.findFirst({
    where: {
      id: input.sessionId,
      shop: input.shop,
      customerId: normalizeCustomerGid(input.customerId),
    },
  });
  if (!session) {
    throw new DomainError(
      "DESIGN_SESSION_MISSING",
      "The design session could not be found.",
      404,
    );
  }
  if (session.version !== input.expectedVersion) {
    throw new DomainError(
      "DESIGN_VERSION_CONFLICT",
      "A newer copy of this design is already saved. Reload it before saving again.",
      409,
    );
  }
  return session;
}

export async function saveDesignSession(input: {
  shop: string;
  customerId: string;
  creatorId?: string;
  sessionId?: string;
  clientKey: string;
  expectedVersion: number;
  productId: string;
  variantId: string;
  mode: DesignerMode;
  designJson: string;
  previewUrl: string;
  artworkUrl: string;
  status: DesignSessionStatus;
}): Promise<DesignSession> {
  const customerId = normalizeCustomerGid(input.customerId);
  validateDesignJson(input.designJson);
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(input.clientKey)) {
    throw new DomainError(
      "DESIGN_SESSION_INVALID",
      "Start a new design session and try again.",
      422,
    );
  }
  const data = {
    creatorId: input.creatorId ?? null,
    shopifyProductId: input.productId,
    shopifyVariantId: input.variantId,
    mode: input.mode,
    designJson: input.designJson,
    previewUrl: input.previewUrl,
    artworkUrl: input.artworkUrl,
    status: input.status,
  };
  if (input.sessionId) {
    const updated = await db.designSession.updateMany({
      where: {
        id: input.sessionId,
        shop: input.shop,
        customerId,
        version: input.expectedVersion,
      },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new DomainError(
        "DESIGN_VERSION_CONFLICT",
        "A newer copy of this design is already saved. Reload it before saving again.",
        409,
      );
    }
    return db.designSession.findUniqueOrThrow({ where: { id: input.sessionId } });
  }
  try {
    return await db.designSession.create({
      data: {
        shop: input.shop,
        customerId,
        clientKey: input.clientKey,
        ...data,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      throw new DomainError(
        "DESIGN_SAVE_IN_PROGRESS",
        "This design is already being saved.",
        409,
      );
    }
    throw error;
  }
}

export function numericVariantId(variantId: string) {
  const value = variantId.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/)?.[1];
  if (!value) {
    throw new DomainError(
      "VARIANT_INVALID",
      "The selected product option is invalid.",
      422,
    );
  }
  return value;
}
