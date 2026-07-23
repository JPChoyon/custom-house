import { addInitialCreatorTags, applyHeliumSync, normalizeCustomerGid, parseHeliumMetafieldMap, fetchHeliumCustomer } from "./helium-sync.server";
import { creatorStatusFromTags, withHeliumCreatorFormTags } from "./helium-sync";
import db from "../db.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";

export interface CustomerWebhookPayload { id?: string | number; admin_graphql_api_id?: string; tags?: string | string[] }

export async function synchronizeCustomerWebhook(shop: string, payload: CustomerWebhookPayload, client?: ShopifyGraphqlClient) {
  const rawId = payload.admin_graphql_api_id || payload.id;
  if (!rawId) return;
  const customerId = normalizeCustomerGid(rawId);
  const payloadTags = Array.isArray(payload.tags) ? payload.tags : String(payload.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  let input = { customerId, tags: payloadTags };
  if (client) {
    const config = await db.shopConfig.findUnique({ where: { shop }, select: { heliumMetafieldMapJson: true, heliumCreatorFormId: true } });
    const fetched = await fetchHeliumCustomer(client, customerId, parseHeliumMetafieldMap(config?.heliumMetafieldMapJson));
    if (fetched) {
      input = withHeliumCreatorFormTags(fetched, config?.heliumCreatorFormId);
      if (!creatorStatusFromTags(fetched.tags) && creatorStatusFromTags(input.tags))
        await addInitialCreatorTags(client, customerId);
    }
  }
  const result = await applyHeliumSync(shop, input, "WEBHOOK");
  console.info("helium_customer_sync", { shop, customerIdExists: true, action: result.action, creatorStatus: result.status });
}
