import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markZakekeOrderState } from "../services/zakeke/zakeke-order-processing.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  await markZakekeOrderState({
    shop,
    shopifyOrderId: `gid://shopify/Order/${String(
      payload.order_id || "",
    )}`,
    state: "REFUNDED",
  });
  return new Response();
}
