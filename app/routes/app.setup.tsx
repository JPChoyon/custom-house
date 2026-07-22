import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { parseJsonList } from "../services/domain";

type SetupQuery = { data?: { metafieldDefinitions: { nodes: Array<{ key: string }> } } };
type PublicationsQuery = { data?: { publications: { nodes: Array<{ id: string; name: string }> } } };
type Readiness = "Ready" | "Available but not active" | "Needs configuration" | "Unable to verify automatically" | "Not available";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const config = await db.shopConfig.upsert({ where: { shop: session.shop }, update: {}, create: { shop: session.shop } });
  const definitionsResponse = await admin.graphql(`#graphql query CustomHouseMetafieldSetup { metafieldDefinitions(first: 20, ownerType: PRODUCT, namespace: "customhouse") { nodes { key } } }`);
  const definitions = await definitionsResponse.json() as SetupQuery;
  let publicationPermissionGranted = true; let publications: Array<{ id: string; name: string }> = [];
  try { const response = await admin.graphql(`#graphql query CustomHousePublications { publications(first: 20) { nodes { id name } } }`); const body = await response.json() as PublicationsQuery; publications = body.data?.publications.nodes ?? []; } catch { publicationPermissionGranted = false; }
  return { config, keys: definitions.data?.metafieldDefinitions.nodes.map((node) => node.key) ?? [], publications, publicationPermissionGranted };
}

export default function SetupGuide() {
  const data = useLoaderData<typeof loader>();
  const metafieldsReady = ["product_origin", "design_mode", "design_status", "creator_profile"].every((key) => data.keys.includes(key));
  const theme: Array<[string, Readiness]> = ["Creator Application block", "Creator Dashboard block", "Creator Submission block", "Creator Attribution block", "Buy-only Product Form block", "InkyBay Compatibility Embed"].map((name) => [name, "Available but not active"]);
  const checks: Array<[string, Readiness]> = [
    ["App authentication", "Ready"], ["Database", "Ready"], ["Product metafields", metafieldsReady ? "Ready" : "Needs configuration"], ["Online Store publication", data.config.onlineStorePublicationId ? "Ready" : "Needs configuration"], ["App Proxy", "Unable to verify automatically"], ...theme,
    ["InkyBay allowed hosts", parseJsonList(data.config.inkybayAllowedHostsJson).length ? "Ready" : "Needs configuration"], ["Creator Profile metaobject mapping", data.config.creatorProfileMetaobjectType && data.config.creatorProfileFieldMapJson ? "Ready" : "Needs configuration"], ["Helium migration", data.config.heliumMigrationCompletedAt ? "Ready" : "Needs configuration"], ["Helium decommission", data.config.heliumDecommissionedAt ? "Ready" : "Available but not active"],
  ];
  return <s-page heading="Setup guide">{!data.publicationPermissionGranted && <s-banner tone="warning"><s-heading>Publication permission is not granted</s-heading><s-paragraph>Approve read_publications and write_publications for this app installation.</s-paragraph></s-banner>}<s-section heading="Readiness"><s-unordered-list>{checks.map(([name, state]) => <s-list-item key={name}>{state}: {name}</s-list-item>)}</s-unordered-list><s-paragraph>Theme components are released and available, but activation must be verified independently in an unpublished duplicate theme.</s-paragraph></s-section></s-page>;
}

export function ErrorBoundary() { useRouteError(); return <s-page heading="Setup guide"><s-banner tone="critical">The Setup Guide could not be loaded. Sensitive diagnostic details are not shown.</s-banner></s-page>; }
export const headers: HeadersFunction = (args) => boundary.headers(args);
