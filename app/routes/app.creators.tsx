import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { changeCreatorStatus } from "../services/creator.server";
import { syncExistingCreators } from "../services/helium-sync.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return db.creator.findMany({ where: { shop: session.shop }, include: { _count: { select: { submissions: true } } }, orderBy: { updatedAt: "desc" }, take: 100 });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "status");
  const client = new AdminGraphqlClient(admin);
  if (intent === "sync-preview" || intent === "sync-apply") {
    const counts = await syncExistingCreators(session.shop, client, intent === "sync-preview");
    return { sync: intent === "sync-preview" ? "preview" : "applied", counts };
  }
  const state = String(form.get("status"));
  if (!( ["APPROVED", "REJECTED", "SUSPENDED"] as string[]).includes(state)) throw new Response("Invalid status", { status: 400 });
  await changeCreatorStatus(session.shop, String(form.get("creatorId")), state as "APPROVED" | "REJECTED" | "SUSPENDED", client, String(form.get("reason") || "") || undefined);
  return { statusChanged: true };
}

export default function Creators() {
  const creators = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const sync = actionData && "sync" in actionData ? actionData : null;
  return <s-page heading="Creators">
    <s-section heading="Sync Existing Creators">
      <p>Preview customers carrying Helium creator tags before importing. App-managed approval decisions are never overwritten.</p>
      {sync?.counts && <p>Create: {sync.counts.create} · Update: {sync.counts.update} · Skip: {sync.counts.skip} · Conflicts: {sync.counts.conflict}</p>}
      <Form method="post"><button name="intent" value="sync-preview">Dry run</button>{sync?.sync === "preview" && <button name="intent" value="sync-apply">Confirm import</button>}</Form>
    </s-section>
    <s-section>{creators.map((creator) => <s-box key={creator.id} padding="base" borderWidth="base" borderRadius="base"><s-heading>{creator.displayName}</s-heading><s-paragraph>{creator.status} · {creator._count.submissions} submissions · {creator.handle}</s-paragraph><Form method="post"><input type="hidden" name="intent" value="status"/><input type="hidden" name="creatorId" value={creator.id}/><input name="reason" aria-label="Reason" placeholder="Reason"/> <button name="status" value="APPROVED">Approve/Reinstate</button> <button name="status" value="SUSPENDED">Suspend</button> <button name="status" value="REJECTED">Reject</button></Form></s-box>)}</s-section>
  </s-page>;
}
