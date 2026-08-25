import { normalizeCustomerGid } from "./helium-sync.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";

export interface CustomerWebhookPayload { id?: string | number; admin_graphql_api_id?: string; tags?: string | string[] }

export async function synchronizeCustomerWebhook(shop: string, payload: CustomerWebhookPayload, _client?: ShopifyGraphqlClient) {
  const rawId = payload.admin_graphql_api_id || payload.id;
  if (!rawId) return;
  normalizeCustomerGid(rawId);
  console.info("customer_creator_sync_skipped", {
    shop,
    customerIdExists: true,
    reason: "custom_creator_application_is_canonical",
  });
}
