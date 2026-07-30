import type { ActionFunctionArgs } from "react-router";
import { publishZakekeCreatorDesign } from "../services/designer-publishing.server";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { jsonBody, proxyContext } from "../services/proxy.server";
import {
  createCustomerDesignPurchase,
  verifyZakekeCallback,
} from "../services/zakeke/zakeke-session.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request, false);
    const body = await jsonBody(request);
    const verified = await verifyZakekeCallback({
      shop,
      customerId,
      sessionToken: String(body.sessionToken || ""),
      designId: body.designId,
      quantity: body.quantity,
      selectedAttributes: body.selectedAttributes,
    });
    if (verified.payload.mode === "CUSTOMER_BUY") {
      return designerApiSuccess(
        await createCustomerDesignPurchase({ shop, verified }),
        201,
      );
    }
    const design = await publishZakekeCreatorDesign({
      shop,
      customerId: customerId || "",
      sessionId: verified.session.id,
      sourceZakekeDesignId: verified.designId,
      title: String(body.title || ""),
      description: String(body.description || ""),
      previewUrl: verified.previewUrl,
      selectedAttributesJson: verified.selectedAttributesJson,
      client,
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
