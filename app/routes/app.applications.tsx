import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
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
  if (!(["APPROVED", "REJECTED"] as string[]).includes(intent))
    throw new Response("Invalid action", { status: 400 });
  await changeCreatorStatus(
    session.shop,
    creatorId,
    intent as "APPROVED" | "REJECTED",
    new AdminGraphqlClient(admin),
    String(form.get("reason") || "") || undefined,
  );
  return { ok: true };
}

export default function Applications() {
  const { rows, audits, shop } = useLoaderData<typeof loader>();
  const store = shop.replace(/\.myshopify\.com$/, "");
  return (
    <s-page heading="Pending Creator Applications">
      <s-section>
        <Form method="get">
          <label>
            Search <input name="search" />
          </label>{" "}
          <label>
            Date <input name="date" type="date" />
          </label>{" "}
          <button type="submit">Filter</button>
        </Form>
      </s-section>
      <s-section>
        {rows.length ? (
          rows.map((item) => {
            const customerNumber = item.creator.customerId.split("/").at(-1);
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
                  {item.status} ·{" "}
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
                {item.profileImageUrl?.startsWith("https://") && (
                  <img
                    src={item.profileImageUrl}
                    alt={`${item.displayName || "Creator"} profile`}
                    width="120"
                    height="120"
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
                  <button name="intent" value="APPROVED">
                    Approve
                  </button>{" "}
                  <button name="intent" value="REJECTED">
                    Reject
                  </button>
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
