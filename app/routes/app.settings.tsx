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
  parseHeliumMetafieldMap,
  serializeHeliumMetafieldMap,
  type HeliumField,
} from "../services/helium-sync";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return db.shopConfig.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });
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
  const config = useLoaderData<typeof loader>();
  const helium = parseHeliumMetafieldMap(config.heliumMetafieldMapJson);
  const heliumFields: Array<[HeliumField, string]> = [
    ["displayName", "Display name"],
    ["biography", "Biography"],
    ["portfolioUrl", "Portfolio URL"],
    ["profileImage", "Profile image"],
    ["applicationAnswers", "Application answers"],
  ];
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
            Enter each mapping as <code>namespace.key</code>. Leave unused
            values blank.
          </p>
          {heliumFields.map(([field, label]) => (
            <p key={field}>
              <label>
                {label}{" "}
                <input
                  name={`helium.${field}`}
                  defaultValue={formatHeliumMappingEntry(helium, field)}
                />
              </label>
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
