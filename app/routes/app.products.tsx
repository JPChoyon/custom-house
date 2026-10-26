import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { AdminStyles, SafeAdminError } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";
import {
  listProductionPricingRows,
  listProductionMethodDefinitions,
  productProductionConfiguration,
  saveProductProductionConfiguration,
  type ProductProductionConfiguration,
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

function configuredRate(
  configuration: ProductProductionConfiguration | undefined,
  method: string,
  tier?: string,
) {
  const configured = configuration?.methods[method];
  if (!configured) return { enabled: false, surcharge: "0.00" };
  if (tier && "tiers" in configured) {
    return configured.tiers[tier] || { enabled: false, surcharge: "0.00" };
  }
  if (!("tiers" in configured)) return configured;
  return { enabled: configured.enabled, surcharge: "0.00" };
}

function tierLabel(tier: string) {
  if (tier === "TEXT_ONLY") return "Text only";
  if (tier === "IMAGE_OR_LOGO") return "Image / Logo";
  return tier.toLowerCase().split("_").filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
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
  const [pricingRows, methodDefinitions] = await Promise.all([
    listProductionPricingRows(session.shop),
    listProductionMethodDefinitions(session.shop),
  ]);
  const configurationByProduct = Object.fromEntries(
    pricingRows
      .filter((row) => row.shopifyProductId.startsWith("gid://shopify/Product/"))
      .map((row) => [row.shopifyProductId, productProductionConfiguration(row)]),
  );
  return {
    products: data.products.nodes,
    configurationByProduct,
    methodDefinitions,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const client = new AdminGraphqlClient(admin);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const currency = String(form.get("currency") || "SEK");
  if (intent !== "save-production-pricing") {
    return {
      ok: false,
      message: "Unsupported product action.",
      productId: null,
      details: [] as string[],
    };
  }

  const productId = String(form.get("shopifyProductId") || "");
  try {
    await verifyPublicCustomizableProduct(client, productId);
    const definitions = await listProductionMethodDefinitions(session.shop);
    const methods = Object.fromEntries(definitions.map((definition) => {
      if (definition.pricingBehavior === "TIERED") {
        const tiers = Object.fromEntries(definition.tiers.map((tier) => [tier, {
          enabled: form.get(`method.${definition.id}.${tier}.enabled`) === "on",
          surcharge: form.get(`method.${definition.id}.${tier}.surcharge`),
        }]));
        return [definition.id, { enabled: true, tiers }];
      }
      return [definition.id, {
        enabled: form.get(`method.${definition.id}.enabled`) === "on",
        surcharge: form.get(`method.${definition.id}.surcharge`),
      }];
    }));
    const result = await saveProductProductionConfiguration(
      session.shop,
      {
        shopifyProductId: productId,
        currency,
        methods,
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
  const { products, configurationByProduct, methodDefinitions } = useLoaderData<typeof loader>();
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
                const configuration = configurationByProduct[product.id];
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
                      <div className="production-method-grid">
                        {methodDefinitions.flatMap((definition) => {
                          const rows = definition.pricingBehavior === "TIERED"
                            ? definition.tiers.map((tier) => ({
                                key: `${definition.id}.${tier}`,
                                label: `${definition.label} — ${tierLabel(tier)}`,
                                tier,
                                rate: configuredRate(configuration, definition.id, tier),
                              }))
                            : [{
                                key: definition.id,
                                label: definition.label,
                                tier: undefined,
                                rate: configuredRate(configuration, definition.id),
                              }];
                          return rows.map((row) => (
                            <div className="production-method-row" key={row.key}>
                              <label className="production-method-enabled">
                                <input
                                  type="checkbox"
                                  name={`method.${definition.id}${row.tier ? `.${row.tier}` : ""}.enabled`}
                                  defaultChecked={row.rate.enabled}
                                />
                                <span>{row.label}</span>
                              </label>
                              <label className="production-method-price">
                                <span>Price</span>
                                <input
                                  name={`method.${definition.id}${row.tier ? `.${row.tier}` : ""}.surcharge`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  defaultValue={row.rate.surcharge}
                                />
                                <small>{currency}</small>
                              </label>
                            </div>
                          ));
                        })}
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
            <details className="settings-card production-pricing-diagnostics">
              <summary className="production-pricing-diagnostics-summary">
                <span className="settings-icon settings-icon--general" />
                <div>
                  <h2>Excluded products ({excludedProducts.length})</h2>
                  <p>
                    Internal, Creator, and non-customizable products are hidden
                    from normal pricing controls.
                  </p>
                </div>
              </summary>
              <div className="settings-toggle-list production-pricing-diagnostics-list">
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
            </details>
          ) : null}
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Marketplace products" />;
}
