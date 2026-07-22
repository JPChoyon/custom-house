import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { parseJsonList } from "../services/domain";
import { HELIUM_FIELDS, parseHeliumMetafieldMap } from "../services/helium-sync";

type SetupQuery = { data?: { metafieldDefinitions: { nodes: Array<{ key: string }> } } };
type Readiness = "Ready" | "Needs configuration" | "Conflict" | "Unable to verify automatically" | "Missing";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const [config, conflicts] = await Promise.all([db.shopConfig.upsert({ where: { shop: session.shop }, update: {}, create: { shop: session.shop } }), db.creator.count({ where: { shop: session.shop, externalSyncConflict: true } })]);
  const response = await admin.graphql(`#graphql query SetupProductMetafields { metafieldDefinitions(first: 20, ownerType: PRODUCT, namespace: "customhouse") { nodes { key } } }`);
  const definitions = await response.json() as SetupQuery;
  return { config, conflicts, keys: definitions.data?.metafieldDefinitions.nodes.map((node) => node.key) ?? [] };
}

export default function SetupGuide() {
  const data = useLoaderData<typeof loader>(); const map = parseHeliumMetafieldMap(data.config.heliumMetafieldMapJson);
  const checks: Array<[string, Readiness]> = [
    ["Product metafields", ["product_origin", "design_mode", "design_status", "creator_profile"].every((key) => data.keys.includes(key)) ? "Ready" : "Missing"],
    ["Online Store publication", data.config.onlineStorePublicationId ? "Ready" : "Needs configuration"],
    ["App Proxy", "Unable to verify automatically"], ["Theme Extension availability", "Unable to verify automatically"], ["Creator Dashboard block", "Unable to verify automatically"], ["Creator Submission block", "Unable to verify automatically"], ["Creator Attribution block", "Unable to verify automatically"], ["Buy-only Product Form block", "Unable to verify automatically"], ["InkyBay Compatibility Embed", "Unable to verify automatically"],
    ["Helium form mapping", HELIUM_FIELDS.every((field) => map[field]?.enabled) ? "Ready" : "Needs configuration"], ["Customer webhook subscriptions", "Unable to verify automatically"], ["Existing creator sync", data.config.heliumMigrationCompletedAt ? "Ready" : "Needs configuration"], ["Pending sync conflicts", data.conflicts ? "Conflict" : "Ready"], ["Creator collection readiness", data.config.automaticCollectionCreationEnabled && data.config.onlineStorePublicationId ? "Ready" : "Needs configuration"], ["InkyBay allowed hosts", parseJsonList(data.config.inkybayAllowedHostsJson).length ? "Ready" : "Needs configuration"],
  ];
  return <s-page heading="Setup guide"><s-section heading="Readiness"><s-unordered-list>{checks.map(([name, state]) => <s-list-item key={name}>{state}: {name}</s-list-item>)}</s-unordered-list><s-paragraph>Theme activation, App Proxy registration, webhook delivery, and Shopify Flow configuration require verification in Shopify Admin.</s-paragraph></s-section></s-page>;
}

export function ErrorBoundary() { useRouteError(); return <s-page heading="Setup guide"><s-banner tone="critical">The Setup Guide could not be loaded. Sensitive diagnostic details are not shown.</s-banner></s-page>; }
export const headers: HeadersFunction = (args) => boundary.headers(args);
