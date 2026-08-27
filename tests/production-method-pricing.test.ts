import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSurchargeInput,
  pricingConfigToMetafieldValue,
} from "../app/services/production-method-pricing.server.ts";
import {
  calculateTrustedProductionTotal,
  preparePublicProductionCart,
} from "../app/services/production-method-cart.server.ts";

test("production method pricing schema matches existing production DB objects", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(
    schema,
    /enum ProductionMethod\s*\{[\s\S]*EMBROIDERY[\s\S]*DTF[\s\S]*DTG[\s\S]*\}/,
  );
  assert.match(schema, /model ProductionMethodSetting\s*\{/);
  assert.match(schema, /description\s+String\s+@default\(""\)/);
  assert.match(schema, /@@unique\(\[shopKey, method\]\)/);
  assert.match(schema, /model PublicProductProductionPricing\s*\{/);
  assert.match(
    schema,
    /embroiderySurcharge\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(10,\s*2\)/,
  );
  assert.match(schema, /dtfSurcharge\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(10,\s*2\)/);
  assert.match(schema, /dtgSurcharge\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(10,\s*2\)/);
  assert.match(schema, /@@unique\(\[shopKey, shopifyProductId\]\)/);
});

test("production method surcharge validation accepts zero and two decimals", () => {
  assert.equal(parseSurchargeInput("0").toFixed(2), "0.00");
  assert.equal(parseSurchargeInput("50.25").toFixed(2), "50.25");
});

test("production method surcharge validation rejects negative and too many decimals", () => {
  assert.throws(() => parseSurchargeInput("-1"), /negative/i);
  assert.throws(() => parseSurchargeInput("1.234"), /two decimals/i);
});

test("production method display config serializes minor units", () => {
  const value = JSON.parse(
    pricingConfigToMetafieldValue({
      currency: "SEK",
      methods: [
        {
          method: "EMBROIDERY",
          label: "Embroidery",
          surcharge: parseSurchargeInput("50.00"),
        },
        {
          method: "DTF",
          label: "DTF printing",
          surcharge: parseSurchargeInput("30.00"),
        },
        {
          method: "DTG",
          label: "DTG printing",
          surcharge: parseSurchargeInput("20.00"),
        },
      ],
    }),
  );

  assert.equal(value.version, 1);
  assert.equal(value.currency, "SEK");
  assert.equal(value.methods.EMBROIDERY.surchargeMinor, 5000);
  assert.equal(value.methods.DTF.surchargeMinor, 3000);
  assert.equal(value.methods.DTG.surchargeMinor, 2000);
});

test("admin products page exposes pricing only for public customizable products", () => {
  const source = readFileSync("app/routes/app.products.tsx", "utf8");

  assert.match(source, /save-production-pricing/);
  assert.match(source, /product_type/);
  assert.match(source, /global_customizable/);
  assert.doesNotMatch(source, /creator_fixed[\s\S]*name="embroiderySurcharge"/);
});

test("admin save flow surfaces Shopify sync failures", () => {
  const service = readFileSync(
    "app/services/production-method-pricing.server.ts",
    "utf8",
  );

  assert.match(service, /metafieldsSet/);
  assert.match(service, /partial/i);
  assert.match(service, /production_method_pricing/);
});

const fakePricingDb = {
  publicProductProductionPricing: {
    async findUnique() {
      return {
        id: "pricing-a",
        shopKey: "shop.test",
        shopifyProductId: "gid://shopify/Product/100",
        embroiderySurcharge: parseSurchargeInput("50.00"),
        dtfSurcharge: parseSurchargeInput("30.00"),
        dtgSurcharge: parseSurchargeInput("20.00"),
        embroideryFeeVariantId: "gid://shopify/ProductVariant/9001",
        dtfFeeVariantId: "gid://shopify/ProductVariant/9002",
        dtgFeeVariantId: "gid://shopify/ProductVariant/9003",
      };
    },
  },
};

const fakeProductClient = {
  async request<T>() {
    return {
      product: {
        id: "gid://shopify/Product/100",
        productType: { value: "global_customizable" },
        pitchprintEnabled: { value: "true" },
        origin: { value: "global" },
        mode: { value: "customizable" },
        variants: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/1",
              legacyResourceId: "1",
              price: "100.00",
              availableForSale: true,
            },
            {
              id: "gid://shopify/ProductVariant/2",
              legacyResourceId: "2",
              price: "110.00",
              availableForSale: true,
            },
          ],
        },
      },
    } as T;
  },
};

test("trusted total uses actual variant prices plus method surcharge", () => {
  const result = calculateTrustedProductionTotal({
    surchargeMinor: 5000n,
    selections: [
      {
        variantId: "gid://shopify/ProductVariant/1",
        priceMinor: 10000n,
        quantity: 1,
      },
      {
        variantId: "gid://shopify/ProductVariant/2",
        priceMinor: 11000n,
        quantity: 2,
      },
    ],
  });

  assert.equal(result.productSubtotalMinor, 32000n);
  assert.equal(result.productionSurchargeMinor, 15000n);
  assert.equal(result.totalQuantity, 3);
  assert.equal(result.totalMinor, 47000n);
});

test("trusted cart prep ignores browser price tampering", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    {
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_123",
      productionMethod: "EMBROIDERY",
      browserSurchargeMinor: 1,
      browserTotalMinor: 2,
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
      ],
    },
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.totals.productSubtotalMinor, 10000n);
  assert.equal(cart.totals.productionSurchargeMinor, 5000n);
  assert.equal(cart.totals.totalMinor, 15000n);
  assert.equal(cart.items[0]?.id, "1");
  assert.equal(cart.items[1]?.id, "9001");
  assert.equal(cart.items[1]?.quantity, 1);
});

test("trusted cart prep supports multi-size fee quantity", async () => {
  const cart = await preparePublicProductionCart(
    "shop.test",
    {
      shopifyProductId: "gid://shopify/Product/100",
      pitchprintProjectId: "pp_123",
      productionMethod: "EMBROIDERY",
      selections: [
        { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
        { variantId: "gid://shopify/ProductVariant/2", quantity: 2 },
      ],
    },
    fakeProductClient,
    fakePricingDb,
  );

  assert.equal(cart.totals.totalMinor, 47000n);
  assert.equal(cart.items[0]?.quantity, 1);
  assert.equal(cart.items[1]?.quantity, 2);
  assert.equal(cart.items[2]?.quantity, 3);
});

test("trusted cart prep rejects invalid method quantity and wrong product variants", async () => {
  await assert.rejects(
    () =>
      preparePublicProductionCart(
        "shop.test",
        {
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_123",
          productionMethod: "SCREENPRINT",
          selections: [
            { variantId: "gid://shopify/ProductVariant/1", quantity: 1 },
          ],
        },
        fakeProductClient,
        fakePricingDb,
      ),
    /valid printing method/i,
  );
  await assert.rejects(
    () =>
      preparePublicProductionCart(
        "shop.test",
        {
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_123",
          productionMethod: "EMBROIDERY",
          selections: [
            { variantId: "gid://shopify/ProductVariant/1", quantity: 0 },
          ],
        },
        fakeProductClient,
        fakePricingDb,
      ),
    /valid quantity/i,
  );
  await assert.rejects(
    () =>
      preparePublicProductionCart(
        "shop.test",
        {
          shopifyProductId: "gid://shopify/Product/100",
          pitchprintProjectId: "pp_123",
          productionMethod: "EMBROIDERY",
          selections: [
            { variantId: "gid://shopify/ProductVariant/999", quantity: 1 },
          ],
        },
        fakeProductClient,
        fakePricingDb,
      ),
    /valid variant/i,
  );
});

test("hidden fee merchandise sync is app managed per public product", () => {
  const service = readFileSync(
    "app/services/production-method-pricing.server.ts",
    "utf8",
  );

  assert.match(service, /syncProductionFeeMerchandise/);
  assert.match(service, /customhouse-production-fee/);
  assert.match(service, /production_fee_parent_product_id/);
  assert.match(service, /productSet/);
  assert.match(service, /Embroidery Production Fee/);
  assert.match(service, /DTF Production Fee/);
  assert.match(service, /DTG Production Fee/);
  assert.match(service, /embroideryFeeVariantId/);
  assert.match(service, /dtfFeeVariantId/);
  assert.match(service, /dtgFeeVariantId/);
});

test("storefront exposes production method pricing without trusting browser money", () => {
  const productDetails = readFileSync(
    "theme-live-cart/blocks/_product-details.liquid",
    "utf8",
  );
  const handoff = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-order-handoff.js",
    "utf8",
  );
  const proxyRoute = readFileSync(
    "app/routes/proxy.api.public-production-cart.tsx",
    "utf8",
  );

  assert.match(productDetails, /data-production-method-pricing/);
  assert.match(productDetails, /data-production-method-section/);
  assert.match(productDetails, /data-production-method-option/);
  assert.match(handoff, /public-production-cart/);
  assert.match(handoff, /productionMethod/);
  assert.match(handoff, /selections/);
  assert.match(handoff, /data-production-method-option/);
  assert.match(handoff, /_customhouse_fee_key/);
  assert.doesNotMatch(handoff, /browserSurchargeMinor/);
  assert.doesNotMatch(handoff, /browserTotalMinor/);
  assert.match(proxyRoute, /proxyContext\(request,\s*false\)/);
  assert.match(proxyRoute, /preparePublicProductionCart/);
});

test("theme cart keeps production fee lines paired with base product quantities", () => {
  const cartItems = readFileSync(
    "theme-live-cart/assets/component-cart-items.js",
    "utf8",
  );

  assert.match(cartItems, /reconcileCustomHouseProductionFees/);
  assert.match(cartItems, /_customhouse_fee_key/);
  assert.match(cartItems, /_customhouse_production_fee/);
  assert.match(cartItems, /cart\/update\.js/);
});
