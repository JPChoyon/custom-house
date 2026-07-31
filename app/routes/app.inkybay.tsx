import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { AdminStyles, SafeAdminError, SubmitButton } from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { synchronizeCreatorDesign } from "../services/designer-publishing.server";
import { DomainError } from "../services/domain";
import { inkyBayConfigurationSummary } from "../services/inkybay/inkybay-config.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [sessions, designs, orders] = await Promise.all([
    db.designSession.findMany({
      where: { shop: session.shop, provider: "INKYBAY" },
      select: {
        id: true,
        status: true,
        publishMode: true,
        title: true,
        inkybayTid: true,
        previewUrl: true,
        productionArtworkKey: true,
        lastErrorCode: true,
        lastErrorReference: true,
        updatedAt: true,
        creator: { select: { displayName: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    db.creatorDesign.findMany({
      where: { shop: session.shop, provider: "INKYBAY" },
      select: {
        id: true,
        title: true,
        status: true,
        syncStatus: true,
        inkybayTid: true,
        shopifyCreatorProductId: true,
        shopifyCollectionId: true,
        productionArtworkKey: true,
        lastErrorCode: true,
        lastErrorReference: true,
        updatedAt: true,
        creator: { select: { displayName: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    db.orderDesignSnapshot.findMany({
      where: { shop: session.shop, provider: "INKYBAY" },
      select: {
        id: true,
        shopifyOrderId: true,
        designTitle: true,
        creatorName: true,
        productionArtworkKey: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return {
    configuration: inkyBayConfigurationSummary(),
    sessions,
    designs,
    orders,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const designId = String(form.get("designId") || "");
  const design = await db.creatorDesign.findFirst({
    where: { id: designId, shop: session.shop, provider: "INKYBAY" },
  });
  if (!design) {
    throw new DomainError("DESIGN_NOT_FOUND", "The design was not found.", 404);
  }
  const client = new AdminGraphqlClient(admin);
  if (intent === "retry") {
    const claimed = await db.creatorDesign.updateMany({
      where: { id: design.id, syncStatus: "FAILED" },
      data: { status: "PROCESSING", syncStatus: "SYNCING", publishError: null },
    });
    if (claimed.count !== 1) {
      throw new DomainError(
        "DESIGN_NOT_RETRYABLE",
        "Only failed design synchronizations can be retried.",
        409,
      );
    }
    await synchronizeCreatorDesign(session.shop, design.id, client);
    return { ok: true, intent };
  }
  if (intent === "hide" || intent === "archive") {
    if (design.shopifyCreatorProductId) {
      const result = await client.request<{
        productUpdate: { userErrors: Array<{ message: string }> };
      }>(
        `#graphql mutation HideInkyBayCreatorProduct($product: ProductUpdateInput!) {
          productUpdate(product: $product) { userErrors { message } }
        }`,
        { product: { id: design.shopifyCreatorProductId, status: "DRAFT" } },
      );
      if (result.productUpdate.userErrors.length) {
        throw new DomainError(
          "SHOPIFY_PRODUCT_HIDE_FAILED",
          "The Shopify product could not be hidden.",
          502,
        );
      }
    }
    await db.creatorDesign.update({
      where: { id: design.id },
      data: {
        status: intent === "archive" ? "ARCHIVED" : "HIDDEN",
        syncStatus: "HIDDEN",
        hiddenReason: intent === "archive" ? "ADMIN_ARCHIVED" : "ADMIN_HIDDEN",
        wasPublishedBeforeSuspension: false,
      },
    });
    return { ok: true, intent };
  }
  throw new DomainError("ACTION_INVALID", "Choose a valid action.", 400);
}

export default function InkyBayAdmin() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const waiting = data.sessions.filter((session) =>
    ["WAITING_FOR_SAVED_DESIGN", "WAITING_FOR_ASSETS"].includes(session.status),
  ).length;
  return (
    <s-page heading="InkyBay Creator Publishing">
      <AdminStyles />
      {result?.ok ? (
        <s-banner tone="success">The InkyBay publishing action completed.</s-banner>
      ) : null}
      <s-section heading="Safe rollout configuration">
        <p>
          Creator publishing: {String(data.configuration.creatorPublishing)} ·
          Manual bridge: {String(data.configuration.manualBridge)} · Official
          callback: {String(data.configuration.customCallback)} · Private
          storage: {data.configuration.privateStorageConfigured ? "Configured" : "Not configured"}
        </p>
        <p>
          The manual bridge remains the supported fallback. The official callback
          must stay disabled until InkyBay supplies and verifies its contract.
        </p>
      </s-section>
      <s-section heading="Publishing sessions">
        <p>{waiting} session(s) are waiting for a saved design or production assets.</p>
        {data.sessions.length ? data.sessions.map((session) => (
          <div className="dashboard-row" key={session.id}>
            <div>
              <strong>{session.title || "Untitled creator design"}</strong>
              <span className="dashboard-muted">
                {session.creator?.displayName || "Creator"} · {session.status} · {session.publishMode}
              </span>
              <span className="dashboard-muted">
                tid: {session.inkybayTid || "Not supplied"} · Preview: {session.previewUrl ? "Ready" : "Missing"} · Production artwork: {session.productionArtworkKey ? "Securely stored" : "Missing"}
              </span>
              {session.lastErrorCode ? <span className="dashboard-muted">{session.lastErrorCode} · Reference {session.lastErrorReference}</span> : null}
            </div>
          </div>
        )) : <p>No InkyBay publishing sessions exist.</p>}
      </s-section>
      <s-section heading="Creator fixed products">
        {data.designs.length ? data.designs.map((design) => (
          <div className="dashboard-row" key={design.id}>
            <div>
              <strong>{design.title}</strong>
              <span className="dashboard-muted">{design.creator.displayName} · {design.status} · {design.syncStatus}</span>
              <span className="dashboard-muted">tid: {design.inkybayTid || "Missing"} · Shopify product: {design.shopifyCreatorProductId || "Not created"}</span>
              {design.productionArtworkKey ? <a href={`/app/inkybay/artwork/${design.id}`} target="_blank" rel="noreferrer">Download production artwork</a> : null}
              {design.lastErrorCode ? <span className="dashboard-muted">{design.lastErrorCode} · Reference {design.lastErrorReference}</span> : null}
            </div>
            <Form method="post">
              <input type="hidden" name="designId" value={design.id} />
              {design.syncStatus === "FAILED" ? <SubmitButton name="intent" value="retry">Retry sync</SubmitButton> : null}{" "}
              {design.status === "ACTIVE" ? <SubmitButton name="intent" value="hide" confirmMessage="Hide this creator product?">Hide</SubmitButton> : null}{" "}
              {design.status !== "ARCHIVED" ? <SubmitButton name="intent" value="archive" confirmMessage="Archive this design and hide its product?">Archive</SubmitButton> : null}
            </Form>
          </div>
        )) : <p>No InkyBay creator fixed products exist.</p>}
      </s-section>
      <s-section heading="Design orders">
        {data.orders.length ? data.orders.map((order) => (
          <p key={order.id}>
            {order.designTitle}{order.creatorName ? ` by ${order.creatorName}` : ""} · {order.shopifyOrderId}{order.productionArtworkKey ? " · Production artwork mapped" : " · Artwork missing"}
          </p>
        )) : <p>No InkyBay creator fixed-product orders exist.</p>}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="InkyBay Creator Publishing" />;
}
