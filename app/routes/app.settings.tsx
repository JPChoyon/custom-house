import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { parseJsonList } from "../services/domain";
import {
  formatHeliumMappingEntry,
  HELIUM_EXPECTED_TYPES,
  HELIUM_FIELDS,
  parseHeliumMetafieldMap,
  serializeHeliumMetafieldMap,
} from "../services/helium-sync";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const config = await db.shopConfig.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });
  const response = await admin.graphql(`#graphql query CustomerMetafieldDiscovery { metafieldDefinitions(first: 100, ownerType: CUSTOMER) { nodes { namespace key name type { name } } } }`);
  const body = await response.json() as { data?: { metafieldDefinitions: { nodes: Array<{ namespace: string; key: string; name: string; type: { name: string } }> } } };
  return { config, definitions: body.data?.metafieldDefinitions.nodes ?? [] };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const hosts = String(form.get("hosts") || "")
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const selectors = String(form.get("selectors") || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return db.shopConfig.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop },
    update: {
      creatorApplicationsEnabled: form.has("applications"),
      allowReapplicationAfterRejection: form.has("reapplication"),
      requireAdminApproval: form.has("approval"),
      automaticCollectionCreationEnabled: form.has("collections"),
      collectionTitleTemplate: String(
        form.get("titleTemplate") || "{creatorName} Designs",
      ),
      collectionHandleSuffix: String(form.get("handleSuffix") || "designs"),
      onlineStorePublicationId: String(form.get("publicationId") || "") || null,
      creatorProfileMetaobjectType:
        String(form.get("metaobjectType") || "") || null,
      creatorProfileFieldMapJson: String(form.get("fieldMap") || "") || null,
      heliumMetafieldMapJson: serializeHeliumMetafieldMap(form),
      inkybayAllowedHostsJson: JSON.stringify(hosts),
      inkybayBuyOnlyHiddenSelectorsJson: JSON.stringify(selectors),
    },
  });
}

export default function Settings() {
  const { config, definitions } = useLoaderData<typeof loader>();
  const helium = parseHeliumMetafieldMap(config.heliumMetafieldMapJson);
  const labels: Record<(typeof HELIUM_FIELDS)[number], string> = { legalName: "Legal name", creatorDisplayName: "Creator display name", country: "Country", city: "City", creatorProfilePhoto: "Creator profile photo", shortCreatorBio: "Short creator bio", portfolioUrl: "Portfolio URL", socialProfiles: "Social profiles", termsAccepted: "Terms accepted", applicationMessage: "Application message" };
  return (
    <s-page heading="Creator Marketplace Settings">
      <s-section>
        <Form method="post">
          <p>
            <label>
              <input
                type="checkbox"
                name="applications"
                defaultChecked={config.creatorApplicationsEnabled}
              />{" "}
            Enable creator applications
          </label>
        </p>
        <p>
          <label>
            <input type="checkbox" name="reapplication" defaultChecked={config.allowReapplicationAfterRejection} /> Allow reapplication after rejection
          </label>
        </p>
          <p>
            <label>
              <input
                type="checkbox"
                name="approval"
                defaultChecked={config.requireAdminApproval}
              />{" "}
              Require admin approval
            </label>
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                name="collections"
                defaultChecked={config.automaticCollectionCreationEnabled}
              />{" "}
              Create creator collections
            </label>
          </p>
          <p>
            <label>
              Collection title{" "}
              <input
                name="titleTemplate"
                defaultValue={config.collectionTitleTemplate}
              />
            </label>
          </p>
          <p>
            <label>
              Handle suffix{" "}
              <input
                name="handleSuffix"
                defaultValue={config.collectionHandleSuffix}
              />
            </label>
          </p>
          <p>
            <label>
              Online Store publication GID{" "}
              <input
                name="publicationId"
                defaultValue={config.onlineStorePublicationId ?? ""}
              />
            </label>
          </p>
          <p>
            <label>
              Allowed InkyBay hosts{" "}
              <textarea
                name="hosts"
                defaultValue={parseJsonList(
                  config.inkybayAllowedHostsJson,
                ).join("\n")}
              />
            </label>
          </p>
          <p>
            <label>
              Buy-only selectors (one per line){" "}
              <textarea
                name="selectors"
                defaultValue={parseJsonList(
                  config.inkybayBuyOnlyHiddenSelectorsJson,
                ).join("\n")}
              />
            </label>
          </p>
          <p>
            <label>
              Creator metaobject type{" "}
              <input
                name="metaobjectType"
                defaultValue={config.creatorProfileMetaobjectType ?? ""}
              />
            </label>
          </p>
          <p>
            <label>
              Field map JSON{" "}
              <textarea
                name="fieldMap"
                defaultValue={config.creatorProfileFieldMapJson ?? ""}
              />
            </label>
          </p>
          <h2>Helium Customer Fields metafields</h2>
          <p>
            Select definitions discovered from Shopify. No Helium key is assumed.
          </p>
          {HELIUM_FIELDS.map((field) => (
            <p key={field}>
              <label>
                <input type="checkbox" name={`helium.${field}.enabled`} defaultChecked={helium[field]?.enabled !== false && Boolean(helium[field])}/> Enable {labels[field]}{" "}
                <select name={`helium.${field}.definition`} defaultValue={formatHeliumMappingEntry(helium, field)}><option value="">Not mapped</option>{definitions.map((definition) => <option key={`${definition.namespace}.${definition.key}`} value={`${definition.namespace}|${definition.key}|${definition.type.name}`}>{definition.name} — {definition.namespace}.{definition.key} ({definition.type.name})</option>)}</select>
              </label>
              <span> {!helium[field] ? "Needs configuration" : !definitions.some((definition) => definition.namespace === helium[field]?.namespace && definition.key === helium[field]?.key) ? "Missing definition" : !HELIUM_EXPECTED_TYPES[field].includes(helium[field]!.type) ? "Invalid type" : "Mapped correctly"}</span>
            </p>
          ))}
          <button type="submit">Save settings</button>
        </Form>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  useRouteError();
  return (
    <s-page heading="Creator Marketplace Settings">
      <s-banner tone="critical">
        Settings could not be loaded. Restart the app preview and try again. No
        settings were changed.
      </s-banner>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
