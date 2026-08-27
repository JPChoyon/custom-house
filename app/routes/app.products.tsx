import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { AdminStyles, SafeAdminError } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import {
  listProductionPricingRows,
  saveProductionPricing,
} from "../services/production-method-pricing.server";

type ProductRow = {
  id: string;
  title: string;
  handle: string;
  status: string;
  tags: string[];
  productType: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  origin: { value: string } | null;
  mode: { value: string } | null;
  designStatus: { value: string } | null;
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string };
    maxVariantPrice: { amount: string; currencyCode: string };
  };
};

type PricingDefaults = {
  embroiderySurcharge: string;
  dtfSurcharge: string;
  dtgSurcharge: string;
  embroideryFeeVariantId: string | null;
  dtfFeeVariantId: string | null;
  dtgFeeVariantId: string | null;
};

function isPublicCustomizableProduct(product: {
  tags?: string[];
  productType: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  origin?: { value: string } | null;
  mode?: { value: string } | null;
}) {
  const tags = new Set((product.tags || []).map((tag) => tag.trim().toLowerCase()));
  const isCreatorFixed =
    product.productType?.value === "creator_fixed" ||
    tags.has("creator-fixed") ||
    product.origin?.value === "creator" ||
    product.mode?.value === "buy_only";
  const isLegacyGlobalCustomizable =
    product.origin?.value === "global" && product.mode?.value === "customizable";
  const hasPitchPrintSignal =
    product.pitchprintEnabled?.value === "true" ||
    tags.has("pitchprint") ||
    tags.has("pitchprint-enabled") ||
    tags.has("pitchprint-designlab") ||
    tags.has("pitchprint-options");
  return (
    !isCreatorFixed &&
    (isLegacyGlobalCustomizable ||
      (product.productType?.value === "global_customizable" && hasPitchPrintSignal) ||
      hasPitchPrintSignal)
  );
}

function moneyRange(product: ProductRow) {
  const min = product.priceRangeV2.minVariantPrice;
  const max = product.priceRangeV2.maxVariantPrice;
  if (min.amount === max.amount) return `${min.amount} ${min.currencyCode}`;
  return `${min.amount} - ${max.amount} ${min.currencyCode}`;
}

function rowDefaults(row?: PricingDefaults): PricingDefaults {
  return {
    embroiderySurcharge: row?.embroiderySurcharge ?? "0.00",
    dtfSurcharge: row?.dtfSurcharge ?? "0.00",
    dtgSurcharge: row?.dtgSurcharge ?? "0.00",
    embroideryFeeVariantId: row?.embroideryFeeVariantId ?? null,
    dtfFeeVariantId: row?.dtfFeeVariantId ?? null,
    dtgFeeVariantId: row?.dtgFeeVariantId ?? null,
  };
}

async function verifyPublicCustomizableProduct(
  client: AdminGraphqlClient,
  productId: string,
) {
  const data = await client.request<{
    product: {
      id: string;
      tags: string[];
      productType: { value: string } | null;
      pitchprintEnabled: { value: string } | null;
      origin: { value: string } | null;
      mode: { value: string } | null;
    } | null;
  }>(
    `#graphql query ProductionPricingProductEligibility($id: ID!) {
      product(id: $id) {
        id tags
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
        origin: metafield(namespace: "customhouse", key: "product_origin") { value }
        mode: metafield(namespace: "customhouse", key: "design_mode") { value }
      }
    }`,
    { id: productId },
  );
  if (!data.product || !isPublicCustomizableProduct(data.product)) {
    throw new Error(
      "Production pricing is only available for public customizable PitchPrint products.",
    );
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const data = await client.request<{
    products: { nodes: ProductRow[] };
  }>(`#graphql
    query MarketplaceProducts {
      products(first: 100, query: "status:active") {
        nodes {
          id title handle status tags
          productType: metafield(namespace: "customhouse", key: "product_type") { value }
          pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
          origin: metafield(namespace: "customhouse", key: "product_origin") { value }
          mode: metafield(namespace: "customhouse", key: "design_mode") { value }
          designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        }
      }
    }
  `);
  const pricingRows = await listProductionPricingRows(session.shop);
  const pricingByProduct = Object.fromEntries(
    pricingRows.map((row) => [
      row.shopifyProductId,
      {
        embroiderySurcharge: row.embroiderySurcharge.toFixed(2),
        dtfSurcharge: row.dtfSurcharge.toFixed(2),
        dtgSurcharge: row.dtgSurcharge.toFixed(2),
        embroideryFeeVariantId: row.embroideryFeeVariantId,
        dtfFeeVariantId: row.dtfFeeVariantId,
        dtgFeeVariantId: row.dtgFeeVariantId,
      },
    ]),
  );
  return {
    products: data.products.nodes,
    pricingByProduct,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent !== "save-production-pricing") {
    return {
      ok: false,
      message: "Unsupported product action.",
      productId: null,
      details: [] as string[],
    };
  }

  const productId = String(form.get("shopifyProductId") || "");
  const currency = String(form.get("currency") || "SEK");
  try {
    await verifyPublicCustomizableProduct(client, productId);
    const result = await saveProductionPricing(
      session.shop,
      {
        shopifyProductId: productId,
        currency,
        embroidery: form.get("embroiderySurcharge"),
        dtf: form.get("dtfSurcharge"),
        dtg: form.get("dtgSurcharge"),
      },
      client,
    );
    return {
      ok: result.status === "saved",
      productId,
      message: result.message,
      details: [
        result.saved ? "Saved" : null,
        result.shopifySynced ? "Shopify config synced" : null,
        result.productionFeeSynced ? "Production fee synced" : null,
        ...result.errors,
      ].filter((item): item is string => Boolean(item)),
    };
  } catch (error) {
    return {
      ok: false,
      productId,
      message:
        error instanceof Error
          ? error.message
          : "Production pricing could not be saved.",
      details: [] as string[],
    };
  }
}

export default function Products() {
  const { products, pricingByProduct } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const eligibleProducts = products.filter(isPublicCustomizableProduct);
  const excludedProducts = products.filter(
    (product) => !isPublicCustomizableProduct(product),
  );

  return (
    <s-page heading="Marketplace products"><AdminStyles /><s-section>
        <div className="settings-admin-page">
          <header className="settings-admin-header">
            <div>
              <h1>Production Pricing</h1>
              <p>
                Configure per-product Printing Method surcharges for public
                customizable PitchPrint products.
              </p>
            </div>
          </header>

          {eligibleProducts.length ? (
            <div className="settings-grid">
              {eligibleProducts.map((product) => {
                const pricing = rowDefaults(pricingByProduct[product.id]);
                const currency =
                  product.priceRangeV2.minVariantPrice.currencyCode;
                const active = actionData?.productId === product.id;
                return (
                  <section className="settings-card" key={product.id}>
                    <div className="settings-card-heading">
                      <span className="settings-icon settings-icon--integration" />
                      <div>
                        <h2>{product.title}</h2>
                        <p>
                          Base Shopify price: {moneyRange(product)} ·{" "}
                          {product.handle}
                        </p>
                      </div>
                    </div>
                    <h3 className="settings-subheading">Production Pricing</h3>
                    {active ? (
                      <s-banner tone={actionData.ok ? "success" : "critical"}>
                        <strong>{actionData.message}</strong>
                        {actionData.details.length ? (
                          <span> {actionData.details.join(" · ")}</span>
                        ) : null}
                      </s-banner>
                    ) : null}
                    <Form method="post" className="settings-field-stack production-pricing-form">
                      <input
                        type="hidden"
                        name="intent"
                        value="save-production-pricing"
                      />
                      <input
                        type="hidden"
                        name="shopifyProductId"
                        value={product.id}
                      />
                      <input type="hidden" name="currency" value={currency} />
                      <div className="production-pricing-fields">
                        <label>
                          <span>Embroidery</span>
                          <input
                            name="embroiderySurcharge"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={pricing.embroiderySurcharge}
                          />
                          <small>{currency}</small>
                        </label>
                        <label>
                          <span>DTF</span>
                          <input
                            name="dtfSurcharge"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={pricing.dtfSurcharge}
                          />
                          <small>{currency}</small>
                        </label>
                        <label>
                          <span>DTG</span>
                          <input
                            name="dtgSurcharge"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={pricing.dtgSurcharge}
                          />
                          <small>{currency}</small>
                        </label>
                      </div>
                      <button
                        type="submit"
                        className="settings-secondary-button"
                      >
                        Save Production Pricing
                      </button>
                    </Form>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="dashboard-empty">
              <strong>No public customizable products were found.</strong>
              <span className="dashboard-muted">
                Products with Custom House product_type global_customizable and
                PitchPrint enabled will appear here.
              </span>
            </div>
          )}

          {excludedProducts.length ? (
            <section className="settings-card">
              <div className="settings-card-heading">
                <span className="settings-icon settings-icon--general" />
                <div>
                  <h2>Excluded Products</h2>
                  <p>Creator and non-customizable products are read-only here.</p>
                </div>
              </div>
              <div className="settings-toggle-list">
                {excludedProducts.map((product) => (
                  <div className="settings-toggle-row" key={product.id}>
                    <span>{product.title}</span>
                    <small>
                      {product.productType?.value ||
                        product.origin?.value ||
                        "Not public customizable"}
                    </small>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Marketplace products" />;
}
