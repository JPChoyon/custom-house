import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { DomainError } from "../services/domain";
import { getStorefrontActor } from "../services/storefront-actor.server";
import { getZakekeFeatureFlags } from "../services/zakeke/zakeke-config.server";
import { requireActiveGlobalProductMapping } from "../services/zakeke/zakeke-products.server";
import { canCreatorPublish } from "../services/designer-publishing";
import { zakekeProductActions } from "../services/zakeke/zakeke-mode";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    const url = new URL(request.url);
    const productId = url.searchParams.get("product_id") || "";
    const productType = url.searchParams.get("product_type") || "";
    const flags = getZakekeFeatureFlags();
    if (!flags.integration) {
      throw new DomainError(
        "ZAKEKE_DISABLED",
        "Product customization is not available.",
        404,
      );
    }
    if (productType === "creator_fixed") {
      let design = await db.creatorDesign.findFirst({
        where: {
          shop: actor.shop,
          shopifyCreatorProductId: productId,
          provider: "ZAKEKE",
          status: "ACTIVE",
          syncStatus: "SYNCED",
        },
        select: {
          id: true,
          title: true,
          previewUrl: true,
          compatibleVariantIdsJson: true,
          shopifyCollectionId: true,
          creator: {
            select: {
              displayName: true,
              status: true,
              suspendedAt: true,
            },
          },
        },
      });
      if (
        design &&
        !canCreatorPublish(
          design.creator.status,
          design.creator.suspendedAt,
        )
      ) {
        design = null;
      }
      let collectionUrl: string | null = null;
      if (design?.shopifyCollectionId) {
        try {
            const result = await actor.client.request<{
            collection: { handle: string } | null;
          }>(
            `#graphql query ZakekeCreatorCollection($id: ID!) {
              collection(id: $id) { handle }
            }`,
            { id: design.shopifyCollectionId },
          );
          collectionUrl = result.collection?.handle
            ? `/collections/${encodeURIComponent(result.collection.handle)}`
            : null;
        } catch {
          collectionUrl = null;
        }
      }
      return designerApiSuccess({
        productType,
        fixedPurchaseAvailable: Boolean(design && flags.fixedPurchase),
        design: design
          ? {
              id: design.id,
              title: design.title,
              previewUrl: design.previewUrl,
              creator: { displayName: design.creator.displayName },
            }
          : null,
        collectionUrl,
      });
    }
    await requireActiveGlobalProductMapping(actor.shop, productId);
    const actions = zakekeProductActions(
      actor,
      flags.creatorPublishing,
    );
    return designerApiSuccess({
      productType: "global_customizable",
      ...actions,
      actor: {
        role: actor.role,
        creatorStatus: actor.creatorStatus,
        normalizedCreatorStatus: actor.normalizedCreatorStatus,
        isCreator: actor.isCreator,
        isApprovedCreator: actor.isApprovedCreator,
        isSuspendedCreator: actor.isSuspendedCreator,
      },
    });
  } catch (error) {
    return designerApiError(error, "zakeke.eligibility");
  }
}
