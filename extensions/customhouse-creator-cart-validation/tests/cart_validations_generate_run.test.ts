import { describe, expect, test } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";

const MESSAGES = {
  nonReturn:
    "Please confirm that you understand this customized product cannot be returned.",
  terms: "Please accept the Terms & Conditions before continuing.",
  fee: "This Creator product's production fee is missing or invalid. Please remove it and add it again.",
  contract: "This Creator product needs to be republished before checkout.",
} as const;

type Contract = {
  version: number;
  creatorProductId: string;
  feeRequired: boolean;
  feeVariantId: string | null;
  placementCount: number;
};

type Line = Record<string, unknown>;

function attribute(value?: string | null) {
  return value == null ? null : { value };
}

function productMetafield(value?: string | null) {
  return value == null ? null : { value };
}

function normalLine(overrides: Partial<Line> = {}): Line {
  return {
    id: "gid://shopify/CartLine/normal",
    quantity: 1,
    creatorProductIdAttribute: null,
    feeKeyAttribute: null,
    productionFeeAttribute: null,
    nonReturnAcknowledgement: null,
    termsAcknowledgement: null,
    merchandise: {
      __typename: "ProductVariant",
      id: "gid://shopify/ProductVariant/normal",
      product: {
        productOrigin: productMetafield("global"),
        designMode: productMetafield("customizable"),
        productType: productMetafield("global"),
        creatorProductId: null,
        creatorCartValidation: null,
      },
    },
    ...overrides,
  };
}

function creatorLine({
  id = "creator-1",
  feeKey = "fee-key-1",
  quantity = 1,
  contract = {
    version: 1,
    creatorProductId: id,
    feeRequired: true,
    feeVariantId: "gid://shopify/ProductVariant/fee-1",
    placementCount: 1,
  },
  nonReturn = "Accepted",
  terms = "Accepted",
}: {
  id?: string;
  feeKey?: string;
  quantity?: number;
  contract?: Contract | unknown | null;
  nonReturn?: string | null;
  terms?: string | null;
} = {}): Line {
  return {
    id: `gid://shopify/CartLine/${id}`,
    quantity,
    creatorProductIdAttribute: attribute(id),
    feeKeyAttribute: attribute(feeKey),
    productionFeeAttribute: null,
    nonReturnAcknowledgement: attribute(nonReturn),
    termsAcknowledgement: attribute(terms),
    merchandise: {
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${id}`,
      product: {
        productOrigin: productMetafield("creator"),
        designMode: productMetafield("buy_only"),
        productType: productMetafield("creator_fixed"),
        creatorProductId: productMetafield(id),
        creatorCartValidation:
          contract == null ? null : { jsonValue: contract },
      },
    },
  };
}

function feeLine({
  id = "creator-1",
  feeKey = "fee-key-1",
  quantity = 1,
  variantId = "gid://shopify/ProductVariant/fee-1",
}: {
  id?: string;
  feeKey?: string;
  quantity?: number;
  variantId?: string;
} = {}): Line {
  return {
    id: `gid://shopify/CartLine/fee-${id}-${feeKey}`,
    quantity,
    creatorProductIdAttribute: attribute(id),
    feeKeyAttribute: attribute(feeKey),
    productionFeeAttribute: attribute("true"),
    nonReturnAcknowledgement: null,
    termsAcknowledgement: null,
    merchandise: {
      __typename: "ProductVariant",
      id: variantId,
      product: {
        productOrigin: null,
        designMode: null,
        productType: productMetafield("production_fee"),
        creatorProductId: null,
        creatorCartValidation: null,
      },
    },
  };
}

function errors(lines: Line[]): ValidationError[] {
  const result = cartValidationsGenerateRun({ cart: { lines } } as never);
  return result.operations[0]?.validationAdd.errors ?? [];
}

type ValidationError = { message: string; target: string };

describe("CustomHouse Creator cart validation", () => {
  test("allows carts with only normal products", () => {
    expect(errors([normalLine({ quantity: 4 })])).toEqual([]);
  });

  test("allows a Creator product with its exact fee pair and acknowledgements", () => {
    expect(errors([creatorLine(), feeLine()])).toEqual([]);
  });

  test("rejects a Creator product with a missing fee", () => {
    expect(errors([creatorLine()])).toContainEqual({
      message: MESSAGES.fee,
      target: "$.cart",
    });
  });

  test("rejects a Creator fee with the wrong quantity", () => {
    expect(
      errors([
        creatorLine({ quantity: 2 }),
        feeLine({ quantity: 1 }),
      ]),
    ).toContainEqual({ message: MESSAGES.fee, target: "$.cart" });
  });

  test("rejects mismatched Creator product and fee pairing", () => {
    expect(
      errors([creatorLine({ feeKey: "product-key" }), feeLine({ feeKey: "fee-key" })]),
    ).toContainEqual({ message: MESSAGES.fee, target: "$.cart" });
  });

  test("requires the non-return acknowledgement on each Creator line", () => {
    expect(
      errors([creatorLine({ nonReturn: null }), feeLine()]),
    ).toContainEqual({ message: MESSAGES.nonReturn, target: "$.cart" });
  });

  test("requires Terms acceptance on each Creator line", () => {
    expect(errors([creatorLine({ terms: null }), feeLine()])).toContainEqual({
      message: MESSAGES.terms,
      target: "$.cart",
    });
  });

  test("allows two Creator products with their individual fees", () => {
    expect(
      errors([
        creatorLine(),
        feeLine(),
        creatorLine({
          id: "creator-2",
          feeKey: "fee-key-2",
          contract: {
            version: 1,
            creatorProductId: "creator-2",
            feeRequired: true,
            feeVariantId: "gid://shopify/ProductVariant/fee-2",
            placementCount: 2,
          },
        }),
        feeLine({
          id: "creator-2",
          feeKey: "fee-key-2",
          quantity: 2,
          variantId: "gid://shopify/ProductVariant/fee-2",
        }),
      ]),
    ).toEqual([]);
  });

  test("rejects the cart when one Creator pair is valid and another is invalid", () => {
    expect(
      errors([
        creatorLine(),
        feeLine(),
        creatorLine({ id: "creator-2", feeKey: "fee-key-2" }),
      ]),
    ).toContainEqual({ message: MESSAGES.fee, target: "$.cart" });
  });

  test("allows a normal product mixed with a valid Creator pair", () => {
    expect(errors([normalLine(), creatorLine(), feeLine()])).toEqual([]);
  });

  test("does not cross-pair products that share a fee key", () => {
    expect(
      errors([
        creatorLine({ id: "creator-1", feeKey: "shared" }),
        feeLine({ id: "creator-1", feeKey: "shared" }),
        creatorLine({ id: "creator-2", feeKey: "shared" }),
      ]),
    ).toContainEqual({ message: MESSAGES.fee, target: "$.cart" });
  });

  test("ignores spoofed Creator attributes on a normal product", () => {
    expect(
      errors([
        normalLine({
          creatorProductIdAttribute: attribute("creator-1"),
          feeKeyAttribute: attribute("fee-key-1"),
          nonReturnAcknowledgement: attribute("Accepted"),
          termsAcknowledgement: attribute("Accepted"),
        }),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["missing", null],
    ["malformed", { version: 1, creatorProductId: "creator-1" }],
    [
      "zero placement",
      {
        version: 1,
        creatorProductId: "creator-1",
        feeRequired: true,
        feeVariantId: "gid://shopify/ProductVariant/fee-1",
        placementCount: 0,
      },
    ],
  ])("fails closed for a %s Creator validation contract", (_label, contract) => {
    expect(errors([creatorLine({ contract }), feeLine()])).toContainEqual({
      message: MESSAGES.contract,
      target: "$.cart",
    });
  });

  test("rejects an orphan Creator fee line", () => {
    expect(errors([feeLine()])).toContainEqual({
      message: MESSAGES.fee,
      target: "$.cart",
    });
  });

  test("allows a zero-fee Creator contract without a fee line", () => {
    expect(
      errors([
        creatorLine({
          contract: {
            version: 1,
            creatorProductId: "creator-1",
            feeRequired: false,
            feeVariantId: null,
            placementCount: 1,
          },
        }),
      ]),
    ).toEqual([]);
  });

  test("aggregates quantities for duplicate Creator lines in the same pair", () => {
    expect(
      errors([
        creatorLine({ quantity: 2 }),
        creatorLine({ quantity: 3 }),
        feeLine({ quantity: 5 }),
      ]),
    ).toEqual([]);
  });
});
