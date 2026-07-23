import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { changeCreatorStatus } from "../services/creator.server";
import { syncExistingCreators } from "../services/helium-sync.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

type CustomerContact = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const creators = await db.creator.findMany({
    where: { shop: session.shop, status: "APPROVED" },
    include: { _count: { select: { submissions: true } } },
    orderBy: { approvedAt: "desc" },
    take: 100,
  });
  let contacts: CustomerContact[] = [];
  if (creators.length) {
    try {
      const result = await new AdminGraphqlClient(admin).request<{
        nodes: Array<CustomerContact | null>;
      }>(
        `#graphql query ApprovedCreatorContacts($ids: [ID!]!) { nodes(ids: $ids) { ... on Customer { id email firstName lastName } } }`,
        { ids: creators.map((creator) => creator.customerId) },
      );
      contacts = result.nodes.filter(
        (contact): contact is CustomerContact => Boolean(contact),
      );
    } catch {
      contacts = [];
    }
  }
  return { creators, contacts };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "status");
  const client = new AdminGraphqlClient(admin);
  if (intent === "sync-preview" || intent === "sync-apply") {
    const counts = await syncExistingCreators(
      session.shop,
      client,
      intent === "sync-preview",
    );
    return { sync: intent === "sync-preview" ? "preview" : "applied", counts };
  }
  const state = String(form.get("status"));
  if (state !== "SUSPENDED")
    throw new Response("Invalid status", { status: 400 });
  await changeCreatorStatus(
    session.shop,
    String(form.get("creatorId")),
    "SUSPENDED",
    client,
    String(form.get("reason") || "") || undefined,
  );
  return { statusChanged: true };
}

export default function Creators() {
  const { creators, contacts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const sync = actionData && "sync" in actionData ? actionData : null;
  const contactById = new Map(
    contacts.map((contact) => [contact.id, contact]),
  );
  return (
    <s-page heading="Approved Creators">
      <s-section heading="Sync Existing Creators">
        <p>
          Dry Run detects creator tags and the configured Helium form ID
          without writing Creator, Application, customer, or collection data.
        </p>
        {sync?.counts && (
          <>
            <p>
              Create: {sync.counts.create} · Update: {sync.counts.update} ·
              Skip: {sync.counts.skip} · Conflicts: {sync.counts.conflict}
            </p>
            <p>
              Applicants found: {sync.counts.applicantsFound} · Applications to
              create: {sync.counts.applicationCreate} · Applications to update:{" "}
              {sync.counts.applicationUpdate}
            </p>
            <p>
              Missing mappings:{" "}
              {sync.counts.missingMappings.join(", ") || "None"} · Invalid
              images: {sync.counts.invalidImageReference}
            </p>
          </>
        )}
        {sync?.counts?.preview?.length ? (
          <details>
            <summary>Per-record preview</summary>
            <ul>
              {sync.counts.preview.map((row) => (
                <li key={row.customerId}>
                  {row.customerId}: {row.action} / {row.status || "no status"}
                  {row.conflict ? " / conflict" : ""} — {row.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <Form method="post">
          <button name="intent" value="sync-preview">
            Dry run
          </button>{" "}
          {sync?.sync === "preview" && (
            <button name="intent" value="sync-apply">
              Confirm import
            </button>
          )}
        </Form>
      </s-section>
      <s-section>
        {creators.length ? (
          creators.map((creator) => {
            const contact = contactById.get(creator.customerId);
            const shopifyName = [contact?.firstName, contact?.lastName]
              .filter(Boolean)
              .join(" ");
            return (
              <s-box
                key={creator.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-heading>
                  {creator.legalName || shopifyName || creator.displayName}
                </s-heading>
                <s-paragraph>
                  APPROVED · {creator._count.submissions} submissions ·{" "}
                  {creator.handle}
                </s-paragraph>
                <p>
                  <strong>Shopify name:</strong>{" "}
                  {shopifyName || "Not available"}
                </p>
                <p>
                  <strong>Email:</strong>{" "}
                  {contact?.email || "Not available"}
                </p>
                <p>
                  <strong>Legal name:</strong>{" "}
                  {creator.legalName || "Not provided"}
                </p>
                <p>
                  <strong>Location:</strong>{" "}
                  {[creator.city, creator.country]
                    .filter(Boolean)
                    .join(", ") || "Not provided"}
                </p>
                <p>
                  <strong>Biography:</strong>{" "}
                  {creator.bio || "Not provided"}
                </p>
                {creator.portfolioUrl && (
                  <p>
                    <a
                      href={creator.portfolioUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Portfolio
                    </a>
                  </p>
                )}
                <p>
                  <strong>Source:</strong> {creator.applicationSource} ·{" "}
                  <strong>Status authority:</strong> {creator.statusAuthority}
                </p>
                <p>
                  <strong>Collection:</strong>{" "}
                  {creator.collectionId || "Not created"}
                </p>
                <Form method="post">
                  <input type="hidden" name="intent" value="status" />
                  <input
                    type="hidden"
                    name="creatorId"
                    value={creator.id}
                  />
                  <input
                    name="reason"
                    aria-label="Suspension reason"
                    placeholder="Suspension reason"
                  />{" "}
                  <button name="status" value="SUSPENDED">
                    Suspend
                  </button>
                </Form>
              </s-box>
            );
          })
        ) : (
          <s-paragraph>No approved creators.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}
