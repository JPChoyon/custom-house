import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { requireApprovedCreator } from "../services/designer-session.server";
import { proxyContext } from "../services/proxy.server";
import { getZakekeFeatureFlags } from "../services/zakeke/zakeke-config.server";
import { requireActiveGlobalProductMapping } from "../services/zakeke/zakeke-products.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request, false);
    const url = new URL(request.url);
    const productId = url.searchParams.get("product_id") || "";
    const productType = url.searchParams.get("product_type") || "";
    const flags = getZakekeFeatureFlags();
    if (productType === "creator_fixed") {
      const design = await db.creatorDesign.findFirst({
        where: {
          shop,
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
          const result = await client.request<{
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
    await requireActiveGlobalProductMapping(shop, productId);
    let creatorPublishAvailable = false;
    if (customerId && flags.creatorPublishing) {
      try {
        await requireApprovedCreator(shop, customerId);
        creatorPublishAvailable = true;
      } catch {
        creatorPublishAvailable = false;
      }
    }
    return designerApiSuccess({
      productType: "global_customizable",
      customerBuyAvailable: true,
      creatorPublishAvailable,
    });
  } catch (error) {
    return designerApiError(error, "zakeke.eligibility");
  }
}
