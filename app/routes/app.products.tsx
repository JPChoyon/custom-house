import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AdminStyles, SafeAdminError } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

type ProductRow = { id: string; title: string; handle: string; status: string; origin: { value: string } | null; mode: { value: string } | null; designStatus: { value: string } | null };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const data = await new AdminGraphqlClient(admin).request<{
    products: { nodes: ProductRow[] };
  }>(`#graphql
    query MarketplaceProducts {
      products(first: 100, query: "metafields.customhouse.product_origin:global OR metafields.customhouse.product_origin:creator") {
        nodes {
          id title handle status
          origin: metafield(namespace: "customhouse", key: "product_origin") { value }
          mode: metafield(namespace: "customhouse", key: "design_mode") { value }
          designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
        }
      }
    }
  `);
  return data.products.nodes;
}

export default function Products() {
  const products = useLoaderData<typeof loader>();
  return <s-page heading="Marketplace products"><AdminStyles /><s-section>{products.length ? products.map((product) => { const warning = !product.origin || !product.mode || !product.designStatus || (product.origin.value === "creator" && product.mode.value !== "buy_only"); return <s-box key={product.id} padding="base" borderWidth="base"><s-heading>{product.title}</s-heading><s-paragraph>{product.origin?.value ?? "Missing origin"} · {product.mode?.value ?? "Missing mode"} · {product.designStatus?.value ?? "Missing status"}</s-paragraph>{warning && <s-banner tone="warning">Product metafields need attention.</s-banner>}</s-box>; }) : <s-paragraph>No marketplace products were found.</s-paragraph>}</s-section></s-page>;
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Marketplace products" />;
}
