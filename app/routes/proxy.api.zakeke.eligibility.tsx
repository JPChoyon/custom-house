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
      const design = await db.creatorDesign.findFirst({
        where: {
          shop: actor.shop,
          shopifyCreatorProductId: productId,
          provider: "ZAKEKE",
          status: "ACTIVE",
          syncStatus: "SYNCED",
          creator: { status: "APPROVED", suspendedAt: null },
        },
        select: {
          id: true,
          title: true,
          previewUrl: true,
          compatibleVariantIdsJson: true,
          shopifyCollectionId: true,
          creator: { select: { displayName: true } },
        },
      });
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
              creator: design.creator,
            }
          : null,
        collectionUrl,
      });
    }
    await requireActiveGlobalProductMapping(actor.shop, productId);
    const creatorPublishAvailable =
      actor.isApprovedCreator && flags.creatorPublishing;
    return designerApiSuccess({
      productType: "global_customizable",
      customerBuyAvailable: true,
      creatorPublishAvailable,
      customerMode: actor.isApprovedCreator
        ? "CREATOR_BUY"
        : "CUSTOMER_BUY",
      actor: {
        role: actor.role,
        creatorStatus: actor.creatorStatus,
        isApprovedCreator: actor.isApprovedCreator,
        isSuspended: actor.isSuspended,
      },
    });
  } catch (error) {
    return designerApiError(error, "zakeke.eligibility");
  }
}
