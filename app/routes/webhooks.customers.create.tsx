import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import { synchronizeCustomerWebhook, type CustomerWebhookPayload } from "../services/helium-webhook.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  try {
    const { admin } = await unauthenticated.admin(shop);
    await synchronizeCustomerWebhook(shop, payload as CustomerWebhookPayload, new AdminGraphqlClient(admin));
    return new Response();
  } catch {
    console.error("legacy_customer_sync_failed", { shop });
    return new Response("Customer synchronization failed", { status: 500 });
  }
}
