import type { ActionFunctionArgs } from "react-router";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { jsonBody, proxyContext } from "../services/proxy.server";
import { prepareFixedCreatorPurchase } from "../services/zakeke/zakeke-purchases.server";

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request, false);
    const body = await jsonBody(request);
    const result = await prepareFixedCreatorPurchase({
      shop,
      customerId,
      creatorDesignId: String(params.designId || ""),
      variantId: String(body.variantId || ""),
      quantity: Number(body.quantity),
      idempotencyKey: String(body.idempotencyKey || ""),
      client,
    });
    return designerApiSuccess(result, 201);
  } catch (error) {
    return designerApiError(error, "zakeke.fixed_purchase");
  }
}
