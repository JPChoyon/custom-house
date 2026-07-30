import type { ActionFunctionArgs } from "react-router";
import { publishZakekeCreatorDesign } from "../services/designer-publishing.server";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { jsonBody } from "../services/proxy.server";
import { getStorefrontActor } from "../services/storefront-actor.server";
import { zakekeCallbackDestination } from "../services/zakeke/zakeke-mode";
import {
  createCustomerDesignPurchase,
  verifyZakekeCallback,
} from "../services/zakeke/zakeke-session.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const actor = await getStorefrontActor(request);
    const body = await jsonBody(request);
    const verified = await verifyZakekeCallback({
      actor,
      sessionToken: String(body.sessionToken || ""),
      callbackProductId: body.productId,
      designId: body.designId,
      quantity: body.quantity,
      selectedAttributes: body.selectedAttributes,
      additionalData: body.additionalData,
      extraOptions: body.extraOptions,
    });
    if (zakekeCallbackDestination(verified.payload.mode) === "cart") {
      return designerApiSuccess(
        await createCustomerDesignPurchase({
          shop: actor.shop,
          verified,
        }),
        201,
      );
    }
    const design = await publishZakekeCreatorDesign({
      shop: actor.shop,
      customerId: actor.customerId || "",
      sessionId: verified.session.id,
      sourceZakekeDesignId: verified.designId,
      title: String(body.title || ""),
      description: String(body.description || ""),
      previewUrl: verified.previewUrl,
      selectedAttributesJson: verified.selectedAttributesJson,
      client: actor.client,
    });
    return designerApiSuccess({
      designId: design.id,
      status: design.status,
      syncStatus: design.syncStatus,
      shopifyProductId: design.shopifyCreatorProductId,
    });
  } catch (error) {
    return designerApiError(error, "zakeke.callback");
  }
}
