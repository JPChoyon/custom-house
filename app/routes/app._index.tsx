import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server"; import { authenticate } from "../shopify.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request); const shop = session.shop;
  const [pendingApplications, approvedCreators, suspendedCreators, pendingSubmissions, publishedProducts, failedJobs, audit] = await Promise.all([
    db.creatorApplication.count({ where: { shop, status: "PENDING" } }), db.creator.count({ where: { shop, status: "APPROVED" } }), db.creator.count({ where: { shop, status: "SUSPENDED" } }),
    db.designSubmission.count({ where: { shop, status: "PENDING" } }), db.designSubmission.count({ where: { shop, status: "PUBLISHED" } }), db.designSubmission.count({ where: { shop, status: "FAILED" } }), db.auditLog.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]); return { pendingApplications, approvedCreators, suspendedCreators, pendingSubmissions, publishedProducts, failedJobs, audit };
}
export default function Dashboard() { const data = useLoaderData<typeof loader>(); const cards = [["Pending applications", data.pendingApplications], ["Approved creators", data.approvedCreators], ["Suspended creators", data.suspendedCreators], ["Pending submissions", data.pendingSubmissions], ["Published products", data.publishedProducts], ["Failed publishing jobs", data.failedJobs]];
  return <s-page heading="Creator Marketplace"><s-section heading="Overview"><s-stack direction="inline" gap="base">{cards.map(([label, value]) => <s-box key={label} padding="base" borderWidth="base" borderRadius="base"><s-heading>{String(value)}</s-heading><s-paragraph>{label}</s-paragraph></s-box>)}</s-stack></s-section><s-section heading="Recent audit activity">{data.audit.length ? <s-unordered-list>{data.audit.map((item) => <s-list-item key={item.id}>{item.action} · {item.entityType} · {new Date(item.createdAt).toLocaleString()}</s-list-item>)}</s-unordered-list> : <s-paragraph>No activity yet.</s-paragraph>}</s-section></s-page>;
}
export function ErrorBoundary() { return boundary.error(useRouteError()); } export const headers: HeadersFunction = (args) => boundary.headers(args);
