import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import {
  AdminStyles,
  SafeAdminError,
  SubmitButton,
} from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  getDesignerConfig,
  isDesignerEnabled,
} from "../services/designer-config.server";
import { retryCreatorDesign } from "../services/designer-publishing.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const enabled = isDesignerEnabled();
  let configured = false;
  let productId: string | null = null;
  let mockupHost: string | null = null;
  if (enabled) {
    try {
      const config = getDesignerConfig();
      configured = true;
      productId = config.shopifyProductId;
      mockupHost = new URL(config.mockupImageUrl).hostname;
    } catch {
      configured = false;
    }
  }
  const designs = await db.creatorDesign.findMany({
    where: { shop: session.shop },
    select: {
      id: true,
      title: true,
      status: true,
      syncStatus: true,
      shopifyCreatorProductId: true,
      publishError: true,
      updatedAt: true,
      creator: { select: { displayName: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  return { enabled, configured, productId, mockupHost, designs };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") !== "retry") {
    throw new Response("Unsupported action", { status: 400 });
  }
  const design = await retryCreatorDesign(
    session.shop,
    String(form.get("designId") ?? ""),
    new AdminGraphqlClient(admin),
  );
  return { ok: true, designId: design.id };
}

export default function DesignerPocAdmin() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <s-page heading="Fabric Designer POC">
      <AdminStyles />
      <s-section heading="Status">
        <p>
          <strong>
            {!data.enabled
              ? "Designer POC disabled"
              : data.configured
                ? "Designer POC enabled for one test product"
                : "Designer POC needs configuration"}
          </strong>
        </p>
        <p>
          The feature is isolated behind <code>CUSTOM_HOUSE_DESIGNER_ENABLED</code>.
          Fabric.js is never loaded on the storefront while it is disabled.
        </p>
        {data.productId ? <p>Test product: {data.productId}</p> : null}
        {data.mockupHost ? <p>Mockup host: {data.mockupHost}</p> : null}
        {actionData?.ok ? <p>Retry completed.</p> : null}
      </s-section>
      <s-section heading="Creator design synchronization">
        {data.designs.length ? (
          data.designs.map((design) => (
            <div className="dashboard-row" key={design.id}>
              <div>
                <strong>{design.title}</strong>
                <span className="dashboard-muted">
                  {design.creator.displayName} · {design.status} · {design.syncStatus}
                </span>
                {design.shopifyCreatorProductId ? (
                  <span className="dashboard-muted">
                    {design.shopifyCreatorProductId}
                  </span>
                ) : null}
                {design.publishError ? (
                  <span className="dashboard-muted">{design.publishError}</span>
                ) : null}
              </div>
              {design.syncStatus === "FAILED" ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="retry" />
                  <input type="hidden" name="designId" value={design.id} />
                  <SubmitButton>Retry synchronization</SubmitButton>
                </Form>
              ) : null}
            </div>
          ))
        ) : (
          <p>No Fabric designer records exist.</p>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Fabric Designer POC" />;
}
