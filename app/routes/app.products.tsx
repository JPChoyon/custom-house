import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

type ProductRow = { id: string; title: string; handle: string; status: string; origin: { value: string } | null; mode: { value: string } | null; designStatus: { value: string } | null };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(`#graphql
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
  const body = await response.json() as { data?: { products: { nodes: ProductRow[] } } };
  return body.data?.products.nodes ?? [];
}

export default function Products() {
  const products = useLoaderData<typeof loader>();
  return <s-page heading="Marketplace products"><s-section>{products.map((product) => { const warning = !product.origin || !product.mode || !product.designStatus || (product.origin.value === "creator" && product.mode.value !== "buy_only"); return <s-box key={product.id} padding="base" borderWidth="base"><s-heading>{product.title}</s-heading><s-paragraph>{product.origin?.value ?? "missing origin"} · {product.mode?.value ?? "missing mode"} · {product.designStatus?.value ?? "missing status"}</s-paragraph>{warning && <s-banner tone="warning">Product metafields need attention.</s-banner>}</s-box>; })}</s-section></s-page>;
}
