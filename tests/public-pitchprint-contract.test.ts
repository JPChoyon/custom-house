import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type PublicContractApi = {
  buildVariantMatrix(input: {
    variants: Array<Record<string, unknown>>;
    optionNames: string[];
    colorPosition?: number;
    sizePosition?: number;
    currency: string;
  }): Array<Record<string, unknown>>;
  integrationSettings(revision: string): Record<string, unknown>;
  chooseCanonicalConfig(
    current: Record<string, unknown> | null,
    candidate: Record<string, unknown>,
  ): Record<string, unknown>;
  revisionFor(value: unknown): string;
};

function loadContract(): PublicContractApi {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(
    readFileSync(
      "theme-live-cart/assets/customhouse-pitchprint-public-contract.js",
      "utf8",
    ),
    sandbox,
  );
  return sandbox.CustomHousePublicPitchPrintContract as PublicContractApi;
}

const variants = [
  {
    id: 101,
    title: "Green / S",
    available: true,
    price: 20000,
    options: ["Green", "S"],
  },
  {
    id: 102,
    title: "Green / M",
    available: false,
    price: 21000,
    options: ["Green", "M"],
  },
  {
    id: 103,
    title: "Black / S",
    available: true,
    price: 22000,
    options: ["Black", "S"],
  },
];

test("public config variant matrix preserves every Shopify variant and semantic option", () => {
  const api = loadContract();
  const matrix = api.buildVariantMatrix({
    variants,
    optionNames: ["Colour", "Size"],
    colorPosition: 1,
    sizePosition: 2,
    currency: "SEK",
  });

  assert.equal(matrix.length, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(matrix)),
    [
      {
        variantId: "101",
        variantGid: "gid://shopify/ProductVariant/101",
        id: "101",
        gid: "gid://shopify/ProductVariant/101",
        title: "Green / S",
        options: { Color: "Green", Size: "S" },
        optionValues: { Colour: "Green", Size: "S" },
        color: "Green",
        size: "S",
        available: true,
        priceMinor: 20000,
        currency: "SEK",
      },
      {
        variantId: "102",
        variantGid: "gid://shopify/ProductVariant/102",
        id: "102",
        gid: "gid://shopify/ProductVariant/102",
        title: "Green / M",
        options: { Color: "Green", Size: "M" },
        optionValues: { Colour: "Green", Size: "M" },
        color: "Green",
        size: "M",
        available: false,
        priceMinor: 21000,
        currency: "SEK",
      },
      {
        variantId: "103",
        variantGid: "gid://shopify/ProductVariant/103",
        id: "103",
        gid: "gid://shopify/ProductVariant/103",
        title: "Black / S",
        options: { Color: "Black", Size: "S" },
        optionValues: { Colour: "Black", Size: "S" },
        color: "Black",
        size: "S",
        available: true,
        priceMinor: 22000,
        currency: "SEK",
      },
    ],
  );
});

test("URL selection and preview color cannot filter the complete public matrix", () => {
  const api = loadContract();
  const matrix = api.buildVariantMatrix({
    variants,
    optionNames: ["Color", "Size"],
    colorPosition: 1,
    sizePosition: 2,
    currency: "SEK",
  });

  assert.deepEqual(matrix.map((variant) => variant.variantId), ["101", "102", "103"]);
  assert.deepEqual(
    Array.from(new Set(matrix.map((variant) => variant.color))),
    ["Green", "Black"],
  );
  assert.deepEqual(
    Array.from(new Set(matrix.map((variant) => variant.size))),
    ["S", "M"],
  );
});

test("public integration settings are explicit and versioned", () => {
  const api = loadContract();
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.integrationSettings("PUBLIC_CUSTOMIZE_V2-test"))),
    {
      mode: "PUBLIC_CUSTOMIZE",
      contractVersion: "PUBLIC_CUSTOMIZE_V2",
      configRevision: "PUBLIC_CUSTOMIZE_V2-test",
      variantSelectionMode: "COLOR_SIZE_MATRIX",
      supportsMultipleVariantSelections: true,
      configRequestMessageType: "CUSTOMHOUSE_PP_ORDER_CONFIG_REQUEST",
      configResponseMessageType: "CUSTOMHOUSE_PP_ORDER_CONFIG_DATA",
      configAcknowledgementMessageType: "CUSTOMHOUSE_PP_ORDER_CONFIG_ACK",
      cartReadyMessageType: "CUSTOMHOUSE_PP_CART_READY",
    },
  );
});

test("repeated public config delivery is idempotent and partial config cannot overwrite complete config", () => {
  const api = loadContract();
  const complete = {
    productId: "gid://shopify/Product/1",
    revision: api.revisionFor({ productId: "1", variants }),
    variants: [{ variantId: "101" }, { variantId: "102" }, { variantId: "103" }],
    integrationSettings: { mode: "PUBLIC_CUSTOMIZE" },
  };
  const same = { ...complete, variants: [...complete.variants] };
  const partial = {
    ...complete,
    revision: api.revisionFor({ productId: "1", variants: [variants[0]] }),
    variants: [{ variantId: "101" }],
  };

  assert.equal(api.chooseCanonicalConfig(complete, same), complete);
  assert.equal(api.chooseCanonicalConfig(complete, partial), complete);
});

test("public handoff carries subtype prices, integration settings, acknowledgements, and rich selections", () => {
  const source = readFileSync(
    "theme-live-cart/assets/customhouse-pitchprint-order-handoff.js",
    "utf8",
  );
  const productDetails = readFileSync(
    "theme-live-cart/blocks/_product-details.liquid",
    "utf8",
  );

  assert.match(productDetails, /data-product-option-names/);
  assert.match(source, /integrationSettings/);
  assert.match(source, /CUSTOMHOUSE_PP_ORDER_CONFIG_ACK/);
  assert.match(source, /PUBLIC_CONFIG_REVISION/);
  assert.match(source, /PUBLIC_CONFIG_VARIANT_COUNT/);
  assert.match(source, /PUBLIC_CONFIG_SENT/);
  assert.match(source, /PUBLIC_CONFIG_ACKNOWLEDGED/);
  assert.match(source, /TEXT_ONLY/);
  assert.match(source, /IMAGE_OR_LOGO/);
  assert.match(source, /variantSelections/);
  assert.match(source, /variantGid/);
  assert.match(source, /color/);
  assert.match(source, /size/);
  assert.doesNotMatch(source, /CustomHouseCreatorPitchPrintConfig/);
});
