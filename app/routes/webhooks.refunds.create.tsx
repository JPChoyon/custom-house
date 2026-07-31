import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markZakekeOrderState } from "../services/zakeke/zakeke-order-processing.server";
import { runtimeEnvironment, sanitizedPreviewSkip } from "../services/environment-safety.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  if (runtimeEnvironment() !== "production") {
    sanitizedPreviewSkip(shop, "refunds/create", "PREVIEW_ORDER_PROCESSING_DENIED");
    return new Response();
  }
  await markZakekeOrderState({
    shop,
    shopifyOrderId: `gid://shopify/Order/${String(
      payload.order_id || "",
    )}`,
    state: "REFUNDED",
  });
  return new Response();
}
