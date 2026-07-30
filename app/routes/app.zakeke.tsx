import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import {
  AdminStyles,
  SafeAdminError,
  SubmitButton,
} from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { retryCreatorDesign } from "../services/designer-publishing.server";
import { DomainError } from "../services/domain";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import { ZakekeAuthService } from "../services/zakeke/zakeke-auth.server";
import { zakekeConnectionSummary } from "../services/zakeke/zakeke-config.server";
import {
  processZakekeOrderJob,
  refreshZakekePrintFiles,
} from "../services/zakeke/zakeke-order-processing.server";
import { saveGlobalProductMapping } from "../services/zakeke/zakeke-products.server";

function status(value: FormDataEntryValue | null) {
  const normalized = String(value || "");
  if (
    !["DRAFT", "TESTING", "ACTIVE", "DISABLED", "ERROR"].includes(
      normalized,
    )
  ) {
    throw new DomainError(
      "ZAKEKE_MAPPING_INVALID",
      "Choose a valid mapping status.",
      422,
    );
  }
  return normalized as
    | "DRAFT"
    | "TESTING"
    | "ACTIVE"
    | "DISABLED"
    | "ERROR";
}

async function hideDesign(
  shop: string,
  designId: string,
  archive: boolean,
  client: AdminGraphqlClient,
) {
  const design = await db.creatorDesign.findFirst({
    where: { id: designId, shop, provider: "ZAKEKE" },
  });
  if (!design) {
    throw new DomainError(
      "DESIGN_NOT_FOUND",
      "The creator design was not found.",
      404,
    );
  }
  if (design.shopifyCreatorProductId) {
    const result = await client.request<{
      productUpdate: { userErrors: Array<{ message: string }> };
    }>(
      `#graphql mutation HideZakekeCreatorProduct($product: ProductUpdateInput!) {
        productUpdate(product: $product) { userErrors { message } }
      }`,
      {
        product: {
          id: design.shopifyCreatorProductId,
          status: "DRAFT",
        },
      },
    );
    if (result.productUpdate.userErrors.length) {
      throw new DomainError(
        "SHOPIFY_PRODUCT_HIDE_FAILED",
        "The Shopify creator product could not be hidden.",
        502,
      );
    }
  }
  return db.creatorDesign.update({
    where: { id: design.id },
    data: {
      status: archive ? "ARCHIVED" : "HIDDEN",
      syncStatus: "HIDDEN",
      hiddenReason: archive ? "ADMIN_ARCHIVED" : "ADMIN_HIDDEN",
      wasPublishedBeforeSuspension: false,
    },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [mappings, designs, purchases, orderJobs, snapshots] =
    await Promise.all([
      db.globalProductMapping.findMany({
        where: { shop: session.shop },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      db.creatorDesign.findMany({
        where: { shop: session.shop, provider: "ZAKEKE" },
        select: {
          id: true,
          title: true,
          status: true,
          syncStatus: true,
          sourceZakekeDesignId: true,
          shopifyCreatorProductId: true,
          shopifyCollectionId: true,
          compatibleVariantIdsJson: true,
          lastErrorCode: true,
          lastErrorReference: true,
          updatedAt: true,
          creator: { select: { displayName: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      db.designPurchase.findMany({
        where: { shop: session.shop },
        select: {
          id: true,
          status: true,
          shopifyProductId: true,
          shopifyVariantId: true,
          creatorDesignId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      db.zakekeOrderJob.findMany({
        where: { shop: session.shop },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      db.orderDesignSnapshot.findMany({
        where: { shop: session.shop },
        select: {
          id: true,
          shopifyOrderId: true,
          designTitle: true,
          creatorName: true,
          printFilesStatus: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
  return {
    connection: zakekeConnectionSummary(),
    mappings,
    designs,
    purchases,
    orderJobs,
    snapshots,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const client = new AdminGraphqlClient(admin);
  if (intent === "test-connection") {
    const token = await new ZakekeAuthService().getS2SToken();
    return { ok: true, intent, expiresAt: token.expiresAt };
  }
  if (intent === "save-mapping") {
    const mapping = await saveGlobalProductMapping({
      shop: session.shop,
      client,
      shopifyProductId: String(form.get("shopifyProductId") || ""),
      zakekeProductCode: String(form.get("zakekeProductCode") || ""),
      variantMappingJson: String(form.get("variantMappingJson") || ""),
      enabled: form.get("enabled") === "on",
      status: status(form.get("status")),
    });
    return { ok: true, intent, id: mapping.id };
  }
  if (intent === "retry-design") {
    const design = await retryCreatorDesign(
      session.shop,
      String(form.get("designId") || ""),
      client,
    );
    return { ok: true, intent, id: design.id };
  }
  if (intent === "retry-order") {
    const job = await processZakekeOrderJob(
      String(form.get("jobId") || ""),
    );
    return { ok: job?.status === "REGISTERED", intent, id: job?.id };
  }
  if (intent === "refresh-files") {
    const result = await refreshZakekePrintFiles(
      String(form.get("jobId") || ""),
    );
    return { ok: true, intent, result };
  }
  if (intent === "hide-design" || intent === "archive-design") {
    const design = await hideDesign(
      session.shop,
      String(form.get("designId") || ""),
      intent === "archive-design",
      client,
    );
    return { ok: true, intent, id: design.id };
  }
  throw new Response("Unsupported action", { status: 400 });
}

export default function ZakekeAdmin() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Zakeke Integration">
      <AdminStyles />
      {result?.ok ? (
        <s-banner tone="success" heading="Zakeke action completed">
          <p>The requested operation completed safely.</p>
        </s-banner>
      ) : null}
      <s-section heading="Connection and feature flags">
        <p>
          Integration: {String(data.connection.integration)} · Creator
          publishing: {String(data.connection.creatorPublishing)} · Fixed
          purchase: {String(data.connection.fixedPurchase)}
        </p>
        <p>
          Credentials:{" "}
          {data.connection.credentialsConfigured
            ? "Configured"
            : "Not configured"}{" "}
          · Session signing:{" "}
          {data.connection.sessionSigningConfigured
            ? "Configured"
            : "Not configured"}{" "}
          · Purchase signing:{" "}
          {data.connection.purchaseSigningConfigured
            ? "Configured"
            : "Not configured"}
        </p>
        <p>
          Production flags must remain false until the complete preview proof of
          concept passes.
        </p>
        <Form method="post">
          <SubmitButton name="intent" value="test-connection">
            Test S2S authentication
          </SubmitButton>
        </Form>
      </s-section>

      <s-section heading="Global Product Mappings">
        <Form method="post">
          <input type="hidden" name="intent" value="save-mapping" />
          <p>
            <label>
              Shopify product GID
              <input
                name="shopifyProductId"
                placeholder="gid://shopify/Product/123"
                required
              />
            </label>
          </p>
          <p>
            <label>
              Zakeke product code
              <input name="zakekeProductCode" required />
            </label>
          </p>
          <p>
            <label>
              Status{" "}
              <select name="status" defaultValue="TESTING">
                <option>DRAFT</option>
                <option>TESTING</option>
                <option>ACTIVE</option>
                <option>DISABLED</option>
                <option>ERROR</option>
              </select>
            </label>{" "}
            <label>
              <input type="checkbox" name="enabled" /> Enabled
            </label>
          </p>
          <p>
            <label>
              Variant mapping JSON
              <textarea
                name="variantMappingJson"
                rows={8}
                required
                defaultValue={`{
  "variants": [
    {
      "shopifyVariantId": "gid://shopify/ProductVariant/123",
      "sku": "TEST-S-BLACK",
      "attributes": { "size": "S", "color": "black" },
      "enabled": true
    }
  ]
}`}
              />
            </label>
          </p>
          <SubmitButton>Validate and save mapping</SubmitButton>
        </Form>
        {data.mappings.map((mapping) => (
          <div className="dashboard-row" key={mapping.id}>
            <div>
              <strong>{mapping.zakekeProductCode}</strong>
              <span className="dashboard-muted">
                {mapping.shopifyProductId} · {mapping.status} ·{" "}
                {mapping.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          </div>
        ))}
      </s-section>

      <s-section heading="Creator Designs and Fixed Products">
        {data.designs.length ? (
          data.designs.map((design) => (
            <div className="dashboard-row" key={design.id}>
              <div>
                <strong>{design.title}</strong>
                <span className="dashboard-muted">
                  {design.creator.displayName} · {design.status} ·{" "}
                  {design.syncStatus}
                </span>
                <span className="dashboard-muted">
                  Source design: {design.sourceZakekeDesignId || "Missing"}
                </span>
                <span className="dashboard-muted">
                  Shopify product:{" "}
                  {design.shopifyCreatorProductId || "Not created"} · Collection:{" "}
                  {design.shopifyCollectionId || "Not assigned"}
                </span>
                {design.lastErrorCode ? (
                  <span className="dashboard-muted">
                    {design.lastErrorCode} · Reference{" "}
                    {design.lastErrorReference}
                  </span>
                ) : null}
              </div>
              <Form method="post">
                <input type="hidden" name="designId" value={design.id} />
                {design.syncStatus === "FAILED" ? (
                  <SubmitButton name="intent" value="retry-design">
                    Retry sync
                  </SubmitButton>
                ) : null}{" "}
                {design.status === "ACTIVE" ? (
                  <SubmitButton name="intent" value="hide-design">
                    Hide
                  </SubmitButton>
                ) : null}{" "}
                {design.status !== "ARCHIVED" ? (
                  <SubmitButton
                    name="intent"
                    value="archive-design"
                    confirmMessage="Archive this creator design and hide its Shopify product?"
                  >
                    Archive
                  </SubmitButton>
                ) : null}
              </Form>
            </div>
          ))
        ) : (
          <p>No Zakeke creator designs exist.</p>
        )}
      </s-section>

      <s-section heading="Design Purchases">
        {data.purchases.length ? (
          data.purchases.map((purchase) => (
            <p key={purchase.id}>
              {purchase.id} · {purchase.status} ·{" "}
              {purchase.creatorDesignId || "Customer customization"}
            </p>
          ))
        ) : (
          <p>No Zakeke design purchases exist.</p>
        )}
      </s-section>

      <s-section heading="Zakeke Orders and Print Files">
        {data.orderJobs.map((job) => (
          <div className="dashboard-row" key={job.id}>
            <div>
              <strong>{job.shopifyOrderCode}</strong>
              <span className="dashboard-muted">
                {job.status} · Attempts {job.attempts}
              </span>
              {job.lastErrorCode ? (
                <span className="dashboard-muted">
                  {job.lastErrorCode} · Reference {job.lastErrorReference}
                </span>
              ) : null}
            </div>
            <Form method="post">
              <input type="hidden" name="jobId" value={job.id} />
              {job.status === "FAILED" ? (
                <SubmitButton name="intent" value="retry-order">
                  Retry registration
                </SubmitButton>
              ) : null}{" "}
              {job.status === "REGISTERED" ? (
                <SubmitButton name="intent" value="refresh-files">
                  Check print files
                </SubmitButton>
              ) : null}
            </Form>
          </div>
        ))}
        {data.snapshots.map((snapshot) => (
          <p key={snapshot.id}>
            {snapshot.designTitle}
            {snapshot.creatorName ? ` by ${snapshot.creatorName}` : ""} ·{" "}
            {snapshot.printFilesStatus}
            {snapshot.printFilesStatus === "AVAILABLE" ? (
              <>
                {" "}
                ·{" "}
                <a
                  href={`/app/zakeke/print-files/${snapshot.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download print files
                </a>
              </>
            ) : null}
          </p>
        ))}
        {!data.orderJobs.length ? <p>No Zakeke orders exist.</p> : null}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Zakeke Integration" />;
}
