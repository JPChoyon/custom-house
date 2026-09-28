import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyPublishedCreatorProduct,
  type PublishedCreatorProductAuditInput,
} from "../scripts/native-marketplace-audit-classifier.ts";

const creatorProductId = "creator-product-1";
const feeVariantId = "gid://shopify/ProductVariant/fee-1";

function compatibleInput(
  overrides: Partial<PublishedCreatorProductAuditInput> = {},
): PublishedCreatorProductAuditInput {
  return {
    creatorProductId,
    shopifyProductId: "gid://shopify/Product/100",
    fixedColor: "Navy Blue",
    fixedProductionMethod: "DTF",
    shopifyProduct: {
      variants: [
        {
          id: "gid://shopify/ProductVariant/101",
          selectedOptions: [
            { name: "Color", value: "navy blue" },
            { name: "Size", value: "M" },
          ],
        },
      ],
      productOrigin: "creator",
      designMode: "buy_only",
      designStatus: "published",
      productType: "creator_fixed",
      creatorProductId,
      creatorCartValidation: {
        version: 1,
        creatorProductId,
        feeRequired: true,
        feeVariantId,
        placementCount: 2,
      },
    },
    ...overrides,
  };
}

test("classifies a fully compatible published Creator product as OK", () => {
  const result = classifyPublishedCreatorProduct(compatibleInput());

  assert.equal(result.category, "OK");
  assert.deepEqual(result.issues, []);
  assert.equal(result.variantCount, 1);
  assert.equal(result.allVariantsMatchFixedColor, true);
  assert.equal(result.canonicalMetafieldsPresent, true);
  assert.equal(result.validationContractPresent, true);
});

test("classifies a missing Shopify product mapping as MISSING_MAPPING", () => {
  const result = classifyPublishedCreatorProduct(
    compatibleInput({ shopifyProductId: null, shopifyProduct: null }),
  );

  assert.equal(result.category, "MISSING_MAPPING");
  assert.match(result.issues.join(" "), /mapping/i);
});

test("classifies a mapped but missing Shopify product as NEEDS_REPAIR", () => {
  const result = classifyPublishedCreatorProduct(
    compatibleInput({ shopifyProduct: null }),
  );

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.match(result.issues.join(" "), /not found/i);
});

test("classifies wrong-color variants as NEEDS_REPAIR", () => {
  const input = compatibleInput();
  input.shopifyProduct!.variants.push({
    id: "gid://shopify/ProductVariant/102",
    selectedOptions: [{ name: "Colour", value: "Red" }],
  });

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.equal(result.allVariantsMatchFixedColor, false);
  assert.match(result.issues.join(" "), /fixed color/i);
});

test("recognizes multilingual color option names", () => {
  for (const name of [
    "Color",
    "Colour",
    "Färg",
    "Farbe",
    "Couleur",
    "Colore",
    "Kleur",
    "Kolor",
    "Cor",
  ]) {
    const input = compatibleInput();
    input.shopifyProduct!.variants = [
      {
        id: `gid://shopify/ProductVariant/${name}`,
        selectedOptions: [{ name, value: "NAVY BLUE" }],
      },
    ];
    assert.equal(
      classifyPublishedCreatorProduct(input).allVariantsMatchFixedColor,
      true,
      name,
    );
  }
});

test("classifies missing canonical identity markers as NEEDS_REPAIR", () => {
  const input = compatibleInput();
  input.shopifyProduct!.designMode = null;

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.equal(result.canonicalMetafieldsPresent, false);
  assert.match(result.issues.join(" "), /design_mode/i);
});

test("classifies a missing validation contract as NEEDS_REPUBLISH", () => {
  const input = compatibleInput();
  input.shopifyProduct!.creatorCartValidation = null;

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPUBLISH");
  assert.equal(result.validationContractPresent, false);
});

test("classifies a malformed validation contract as NEEDS_REPUBLISH", () => {
  const input = compatibleInput();
  input.shopifyProduct!.creatorCartValidation = {
    version: 1,
    creatorProductId,
    feeRequired: true,
    feeVariantId: null,
    placementCount: 0,
  };

  const result = classifyPublishedCreatorProduct(input);

  assert.equal(result.category, "NEEDS_REPUBLISH");
  assert.match(result.issues.join(" "), /validation contract/i);
});

test("classifies missing saved setup fields as NEEDS_REPAIR", () => {
  const result = classifyPublishedCreatorProduct(
    compatibleInput({ fixedProductionMethod: null }),
  );

  assert.equal(result.category, "NEEDS_REPAIR");
  assert.match(result.issues.join(" "), /production method/i);
});

test("the executable audit remains read-only", () => {
  const source = readFileSync(
    new URL("../scripts/native-marketplace-audit.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /#graphql\s+mutation\b/i);
  assert.doesNotMatch(
    source,
    /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
  );
});
