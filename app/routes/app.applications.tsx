import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import {
  AdminStyles,
  SafeAdminError,
  StatusBadge,
  SubmitButton,
} from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { changeCreatorStatus } from "../services/creator.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim();
  const date = url.searchParams.get("date");
  const createdAt =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? {
          gte: new Date(`${date}T00:00:00.000Z`),
          lt: new Date(`${date}T23:59:59.999Z`),
        }
      : undefined;
  const rows = await db.creatorApplication.findMany({
    where: {
      shop: session.shop,
      status: "PENDING",
      createdAt,
      OR: search
        ? [
            { displayName: { contains: search, mode: "insensitive" } },
            { legalName: { contains: search, mode: "insensitive" } },
            {
              creator: {
                handle: { contains: search, mode: "insensitive" },
              },
            },
          ]
        : undefined,
    },
    include: { creator: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const audits = await db.auditLog.findMany({
    where: {
      shop: session.shop,
      OR: [
        { entityId: { in: rows.map((row) => row.id) } },
        { entityId: { in: rows.map((row) => row.creatorId) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return { rows, audits, shop: session.shop };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const creatorId = String(form.get("creatorId"));
  const intent = String(form.get("intent"));
  if (intent === "SAVE_NOTE") {
    const applicationId = String(form.get("applicationId"));
    const note = String(form.get("note") || "").trim();
    if (!applicationId || note.length > 1000)
      throw new Response("Invalid application note", { status: 400 });
    const application = await db.creatorApplication.findFirst({
      where: { id: applicationId, creatorId, shop: session.shop },
      select: { id: true, reviewerNote: true },
    });
    if (!application)
      throw new Response("Application not found", { status: 404 });
    await db.$transaction([
      db.creatorApplication.update({
        where: { id: application.id },
        data: { reviewerNote: note || null },
      }),
      db.auditLog.create({
        data: {
          shop: session.shop,
          actorType: "ADMIN",
          action: "application.note_updated",
          entityType: "CreatorApplication",
          entityId: application.id,
          beforeJson: JSON.stringify({
            notePresent: Boolean(application.reviewerNote),
          }),
          afterJson: JSON.stringify({ notePresent: Boolean(note) }),
        },
      }),
    ]);
    return { ok: true, message: "Admin note saved." };
  }
  if (!(["APPROVED", "REJECTED"] as string[]).includes(intent))
    throw new Response("Invalid action", { status: 400 });
  await changeCreatorStatus(
    session.shop,
    creatorId,
    intent as "APPROVED" | "REJECTED",
    new AdminGraphqlClient(admin),
    String(form.get("reason") || "") || undefined,
  );
  return {
    ok: true,
    message:
      intent === "APPROVED"
        ? "Creator approved."
        : "Application rejected.",
  };
}

export default function Applications() {
  const { rows, audits, shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const store = shop.replace(/\.myshopify\.com$/, "");
  return (
    <s-page heading="Pending Creator Applications">
      <AdminStyles />
      {actionData?.message && (
        <s-section>
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-section>
      )}
      <s-section>
        <Form method="get">
          <label>
            Search <input name="search" />
          </label>{" "}
          <label>
            Date <input name="date" type="date" />
          </label>{" "}
          <SubmitButton>Filter</SubmitButton>
        </Form>
      </s-section>
      <s-section>
        {rows.length ? (
          rows.map((item) => {
            const customerNumber = item.creator.customerId.split("/").at(-1);
            let socialLinks: string[] = [];
            try {
              const parsed = JSON.parse(item.socialLinksJson);
              socialLinks = Array.isArray(parsed)
                ? parsed.filter(
                    (link): link is string =>
                      typeof link === "string" &&
                      link.startsWith("https://"),
                  )
                : [];
            } catch {
              socialLinks = [];
            }
            const history = audits.filter(
              (audit) =>
                audit.entityId === item.id ||
                audit.entityId === item.creatorId,
            );
            return (
              <s-box
                key={item.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-heading>
                  {item.displayName || item.creator.displayName}
                </s-heading>
                <s-paragraph>
                  <StatusBadge status={item.status} /> ·{" "}
                  {new Date(item.createdAt).toLocaleDateString()} · Source:{" "}
                  {item.source}
                </s-paragraph>
                <p>
                  <strong>Legal name:</strong>{" "}
                  {item.legalName || "Not provided"}
                </p>
                <p>
                  <strong>Location:</strong>{" "}
                  {[item.city, item.country].filter(Boolean).join(", ") ||
                    "Not provided"}
                </p>
                <p>
                  <strong>Biography:</strong>{" "}
                  {item.bio || "Not provided"}
                </p>
                {item.portfolioUrl && (
                  <p>
                    <a
                      href={item.portfolioUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Portfolio
                    </a>
                  </p>
                )}
                <p>
                  <strong>Social profiles:</strong>{" "}
                  {socialLinks.length
                    ? socialLinks.map((link, index) => (
                        <span key={link}>
                          {index ? " · " : ""}
                          <a href={link} target="_blank" rel="noreferrer">
                            Profile {index + 1}
                          </a>
                        </span>
                      ))
                    : "Not provided"}
                </p>
                {item.profileImageUrl?.startsWith("https://") && (
                  <img
                    src={item.profileImageUrl}
                    alt={`${item.displayName || "Creator"} profile`}
                    width="120"
                    height="120"
                    className="dashboard-avatar"
                  />
                )}
                <p>
                  <a
                    href={`https://admin.shopify.com/store/${store}/customers/${customerNumber}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View Shopify customer
                  </a>
                </p>
                <Form method="post">
                  <input
                    type="hidden"
                    name="creatorId"
                    value={item.creatorId}
                  />
                  <label>
                    Decision reason <input name="reason" />
                  </label>{" "}
                  <SubmitButton
                    name="intent"
                    value="APPROVED"
                    confirmMessage="Approve this creator? Their creator account and collection setup will be activated."
                  >
                    Approve
                  </SubmitButton>{" "}
                  <SubmitButton
                    name="intent"
                    value="REJECTED"
                    confirmMessage="Reject this creator application? The decision will be recorded in the status history."
                  >
                    Reject
                  </SubmitButton>
                </Form>
                <Form method="post">
                  <input
                    type="hidden"
                    name="creatorId"
                    value={item.creatorId}
                  />
                  <input
                    type="hidden"
                    name="applicationId"
                    value={item.id}
                  />
                  <label>
                    Admin note{" "}
                    <textarea
                      name="note"
                      defaultValue={item.reviewerNote ?? ""}
                      maxLength={1000}
                      rows={3}
                    />
                  </label>{" "}
                  <SubmitButton name="intent" value="SAVE_NOTE">
                    Save note
                  </SubmitButton>
                </Form>
                <details>
                  <summary>Audit history ({history.length})</summary>
                  <ul>
                    {history.map((audit) => (
                      <li key={audit.id}>
                        {new Date(audit.createdAt).toLocaleString()}:{" "}
                        {audit.action}
                      </li>
                    ))}
                  </ul>
                </details>
              </s-box>
            );
          })
        ) : (
          <s-paragraph>No pending applications.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creator Applications" />;
}
