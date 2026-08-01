import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { snapshotCreatorFixedOrder } from "../services/order-design-snapshot.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  await snapshotCreatorFixedOrder(shop, payload);
  return new Response();
}
