export type PublishedCreatorProductAuditCategory =
  | "OK"
  | "NEEDS_REPUBLISH"
  | "NEEDS_REPAIR"
  | "MISSING_MAPPING";

type AuditedVariant = {
  id: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

export type PublishedCreatorProductAuditInput = {
  creatorProductId: string;
  shopifyProductId: string | null;
  fixedColor: string | null;
  fixedProductionMethod: string | null;
  shopifyProduct: {
    variants: AuditedVariant[];
    productOrigin: string | null;
    designMode: string | null;
    designStatus: string | null;
    productType: string | null;
    creatorProductId: string | null;
    creatorCartValidation: unknown | null;
  } | null;
};

export type PublishedCreatorProductAuditResult = {
  category: PublishedCreatorProductAuditCategory;
  issues: string[];
  variantCount: number;
  allVariantsMatchFixedColor: boolean;
  canonicalMetafieldsPresent: boolean;
  validationContractPresent: boolean;
};

const COLOR_OPTION_NAMES = new Set([
  "color",
  "colour",
  "farg",
  "farbe",
  "couleur",
  "colore",
  "kleur",
  "kolor",
  "cor",
]);

function normalizedText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("en");
}

function variantColor(variant: AuditedVariant) {
  return variant.selectedOptions.find((option) =>
    COLOR_OPTION_NAMES.has(normalizedText(option.name)),
  )?.value;
}

function parsedContract(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parsedContract(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validValidationContract(value: unknown, creatorProductId: string) {
  const contract = parsedContract(value);
  if (
    !contract ||
    contract.version !== 1 ||
    contract.creatorProductId !== creatorProductId ||
    typeof contract.feeRequired !== "boolean" ||
    !Number.isInteger(contract.placementCount) ||
    (contract.placementCount as number) < 1
  ) {
    return false;
  }
  return contract.feeRequired
    ? typeof contract.feeVariantId === "string" &&
        contract.feeVariantId.length > 0
    : contract.feeVariantId === null;
}

export function classifyPublishedCreatorProduct(
  input: PublishedCreatorProductAuditInput,
): PublishedCreatorProductAuditResult {
  if (!input.shopifyProductId) {
    return {
      category: "MISSING_MAPPING",
      issues: ["missing published Shopify product mapping"],
      variantCount: 0,
      allVariantsMatchFixedColor: false,
      canonicalMetafieldsPresent: false,
      validationContractPresent: false,
    };
  }

  if (!input.shopifyProduct) {
    return {
      category: "NEEDS_REPAIR",
      issues: ["mapped Shopify product was not found"],
      variantCount: 0,
      allVariantsMatchFixedColor: false,
      canonicalMetafieldsPresent: false,
      validationContractPresent: false,
    };
  }

  const product = input.shopifyProduct;
  const repairIssues: string[] = [];
  const republishIssues: string[] = [];
  const canonicalChecks = [
    ["customhouse.product_origin", product.productOrigin, "creator"],
    ["customhouse.design_mode", product.designMode, "buy_only"],
    ["customhouse.design_status", product.designStatus, "published"],
    ["customhouse.product_type", product.productType, "creator_fixed"],
    [
      "customhouse.creator_product_id",
      product.creatorProductId,
      input.creatorProductId,
    ],
  ] as const;
  const missingCanonical = canonicalChecks
    .filter(([, actual, expected]) => actual !== expected)
    .map(([name]) => name);
  const canonicalMetafieldsPresent = missingCanonical.length === 0;
  if (!canonicalMetafieldsPresent) {
    repairIssues.push(
      `missing or incorrect canonical metafields: ${missingCanonical.join(", ")}`,
    );
  }

  if (!input.fixedColor?.trim()) {
    repairIssues.push("saved fixed color is missing");
  }
  if (!input.fixedProductionMethod?.trim()) {
    repairIssues.push("saved fixed production method is missing");
  }

  const normalizedFixedColor = input.fixedColor
    ? normalizedText(input.fixedColor)
    : "";
  const allVariantsMatchFixedColor =
    normalizedFixedColor.length > 0 &&
    product.variants.length > 0 &&
    product.variants.every((variant) => {
      const color = variantColor(variant);
      return Boolean(color && normalizedText(color) === normalizedFixedColor);
    });
  if (!allVariantsMatchFixedColor) {
    repairIssues.push("Shopify variants do not all match the saved fixed color");
  }

  const validationContractPresent = validValidationContract(
    product.creatorCartValidation,
    input.creatorProductId,
  );
  if (!validationContractPresent) {
    republishIssues.push(
      "Creator validation contract customhouse.creator_cart_validation is missing or invalid; republish this Creator product",
    );
  }

  const category: PublishedCreatorProductAuditCategory = repairIssues.length
    ? "NEEDS_REPAIR"
    : republishIssues.length
      ? "NEEDS_REPUBLISH"
      : "OK";

  return {
    category,
    issues: [...repairIssues, ...republishIssues],
    variantCount: product.variants.length,
    allVariantsMatchFixedColor,
    canonicalMetafieldsPresent,
    validationContractPresent,
  };
}
