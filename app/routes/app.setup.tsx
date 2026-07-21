import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { parseJsonList } from "../services/domain";

type SetupQuery = { data?: { metafieldDefinitions: { nodes: Array<{ key: string }> } } };
type PublicationsQuery = { data?: { publications: { nodes: Array<{ id: string; name: string }> } } };

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const config = await db.shopConfig.findUnique({ where: { shop: session.shop } });

  const definitionsResponse = await admin.graphql(`#graphql
    query CustomHouseMetafieldSetup {
      metafieldDefinitions(first: 20, ownerType: PRODUCT, namespace: "customhouse") {
        nodes { key }
      }
    }
  `);
  const definitions = await definitionsResponse.json() as SetupQuery;

  let publicationPermissionGranted = true;
  let publications: Array<{ id: string; name: string }> = [];
  try {
    const publicationsResponse = await admin.graphql(`#graphql
      query CustomHousePublications {
        publications(first: 20) { nodes { id name } }
      }
    `);
    const publicationBody = await publicationsResponse.json() as PublicationsQuery;
    publications = publicationBody.data?.publications.nodes ?? [];
  } catch {
    publicationPermissionGranted = false;
  }

  return {
    config,
    keys: definitions.data?.metafieldDefinitions.nodes.map((node) => node.key) ?? [],
    publications,
    publicationPermissionGranted,
  };
}

export default function SetupGuide() {
  const data = useLoaderData<typeof loader>();
  const checks = [
    ["Four product metafields", ["product_origin", "design_mode", "design_status", "creator_profile"].every((key) => data.keys.includes(key))],
    ["Online Store publication selected", data.publicationPermissionGranted && Boolean(data.config?.onlineStorePublicationId)],
    ["InkyBay allowed hosts", Boolean(data.config && parseJsonList(data.config.inkybayAllowedHostsJson).length)],
    ["App proxy", true],
    ["Theme extension deployed", false],
  ] as const;

  return <s-page heading="Setup guide">{!data.publicationPermissionGranted && <s-banner tone="warning"><s-heading>Publication permission is not granted</s-heading><s-paragraph>Add read_publications and write_publications to the app configuration, restart Shopify development mode, and approve the updated access request for the development store.</s-paragraph></s-banner>}<s-section heading="Detected readiness"><s-unordered-list>{checks.map(([name, ok]) => <s-list-item key={name}>{ok ? "Ready" : "Needs action"}: {name}</s-list-item>)}</s-unordered-list><s-paragraph>Mark Global Products: origin global, mode customizable, status published, creator profile empty. Add the five blocks and compatibility embed in the Theme Editor after deploying the extension.</s-paragraph></s-section></s-page>;
}

export function ErrorBoundary() {
  useRouteError();
  return <s-page heading="Setup guide"><s-banner tone="critical">The Setup Guide could not be loaded. Restart the app preview and try again. Sensitive diagnostic details are not shown here.</s-banner></s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
