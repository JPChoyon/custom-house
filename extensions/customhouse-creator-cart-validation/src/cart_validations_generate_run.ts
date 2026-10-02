import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

type Attribute = { value?: string | null } | null;

type Metafield = { value?: string | null; jsonValue?: unknown } | null;

type Product = {
  id?: string;
  productOrigin?: Metafield;
  designMode?: Metafield;
  productType?: Metafield;
  creatorProductId?: Metafield;
  creatorCartValidation?: Metafield;
  productionMethodPricing?: Metafield;
};

type CartLine = CartValidationsGenerateRunInput["cart"]["lines"][number];

type CreatorCartValidationContract = {
  version: 1;
  creatorProductId: string;
  feeRequired: boolean;
  feeVariantId: string | null;
  placementCount: number;
};

type CreatorGroup = {
  expectedFeeQuantity: number;
  contract: CreatorCartValidationContract | null;
};

type PublicCartValidationContract = {
  version: 1;
  feeRequired: true;
  feeVariantId: string;
  productionMethod: "EMBROIDERY" | "DTF" | "DTG";
  embroiderySubtype: "TEXT_ONLY" | "IMAGE_OR_LOGO" | null;
  placementCount: number;
};

type PublicGroup = {
  expectedFeeQuantity: number;
  expectedFeeVariantId: string | null;
  valid: boolean;
};

type FeeGroup = {
  quantity: number;
  variantIds: string[];
  kind: "creator" | "public";
};

const TARGET = "$.cart";

const MESSAGES = {
  nonReturn:
    "Please confirm that you understand this customized product cannot be returned.",
  terms: "Please accept the Terms & Conditions before continuing.",
  fee: "This Creator product's production fee is missing or invalid. Please remove it and add it again.",
  contract: "This Creator product needs to be republished before checkout.",
  publicFee:
    "This customized product's production fee is missing or invalid. Please remove it and add it again.",
  publicContract:
    "This customized product needs to be added again before checkout.",
} as const;

function attributeValue(attribute: Attribute | undefined): string | null {
  return typeof attribute?.value === "string" && attribute.value.length > 0
    ? attribute.value
    : null;
}

function metafieldValue(metafield: Metafield | undefined): string | null {
  return typeof metafield?.value === "string" && metafield.value.length > 0
    ? metafield.value
    : null;
}

function productFor(line: CartLine): Product | null {
  return line.merchandise.__typename === "ProductVariant" &&
    line.merchandise.product
    ? line.merchandise.product
    : null;
}

function isCreatorProduct(product: Product | null): product is Product {
  return (
    metafieldValue(product?.productOrigin) === "creator" &&
    metafieldValue(product?.designMode) === "buy_only" &&
    metafieldValue(product?.productType) === "creator_fixed" &&
    metafieldValue(product?.creatorProductId) !== null
  );
}

function isPublicCustomizableProduct(product: Product | null): product is Product {
  const origin = metafieldValue(product?.productOrigin);
  const mode = metafieldValue(product?.designMode);
  const productType = metafieldValue(product?.productType);
  return Boolean(
    product?.id &&
      ((origin === "global" && mode === "customizable") ||
        productType === "global_customizable"),
  );
}

function creatorFeeKey(creatorProductId: string, feeKey: string): string {
  return `${creatorProductId.length}:${creatorProductId}${feeKey}`;
}

function cleanProductionMethod(value: unknown) {
  const method = String(value || "").trim().toUpperCase();
  return method === "EMBROIDERY" || method === "DTF" || method === "DTG"
    ? method
    : null;
}

function cleanEmbroiderySubtype(value: unknown) {
  const raw = String(value || "").trim().toUpperCase();
  const subtype = raw === "IMAGE_LOGO" ? "IMAGE_OR_LOGO" : raw;
  return subtype === "TEXT_ONLY" || subtype === "IMAGE_OR_LOGO"
    ? subtype
    : null;
}

function parsePublicContract(value: string | null): PublicCartValidationContract | null {
  if (!value) return null;
  let candidate: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    candidate = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const productionMethod = cleanProductionMethod(candidate.productionMethod);
  const embroiderySubtype = candidate.embroiderySubtype == null
    ? null
    : cleanEmbroiderySubtype(candidate.embroiderySubtype);
  if (
    candidate.version !== 1 ||
    candidate.feeRequired !== true ||
    typeof candidate.feeVariantId !== "string" ||
    !candidate.feeVariantId.startsWith("gid://shopify/ProductVariant/") ||
    !productionMethod ||
    !Number.isInteger(candidate.placementCount) ||
    (candidate.placementCount as number) < 1 ||
    (productionMethod === "EMBROIDERY" && !embroiderySubtype) ||
    (productionMethod !== "EMBROIDERY" && embroiderySubtype !== null)
  ) {
    return null;
  }
  return {
    version: 1,
    feeRequired: true,
    feeVariantId: candidate.feeVariantId,
    productionMethod,
    embroiderySubtype,
    placementCount: candidate.placementCount as number,
  };
}

function publicPricingRate(
  product: Product,
  contract: PublicCartValidationContract,
): { surchargeMinor: number; feeVariantGid: string } | null {
  const value = product.productionMethodPricing?.jsonValue;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pricing = value as Record<string, unknown>;
  const methods =
    pricing.productionMethodPricing &&
    typeof pricing.productionMethodPricing === "object" &&
    !Array.isArray(pricing.productionMethodPricing)
      ? (pricing.productionMethodPricing as Record<string, unknown>)
      : {};
  let rate: unknown = methods[contract.productionMethod];
  if (contract.productionMethod === "EMBROIDERY") {
    const embroideryMethod =
      rate && typeof rate === "object" && !Array.isArray(rate)
        ? (rate as Record<string, unknown>)
        : {};
    const nested =
      embroideryMethod.embroiderySubtypes &&
      typeof embroideryMethod.embroiderySubtypes === "object" &&
      !Array.isArray(embroideryMethod.embroiderySubtypes)
        ? (embroideryMethod.embroiderySubtypes as Record<string, unknown>)
        : pricing.embroideryPricing &&
            typeof pricing.embroideryPricing === "object" &&
            !Array.isArray(pricing.embroideryPricing)
          ? (pricing.embroideryPricing as Record<string, unknown>)
          : {};
    rate = contract.embroiderySubtype ? nested[contract.embroiderySubtype] : null;
  }
  if (!rate || typeof rate !== "object" || Array.isArray(rate)) return null;
  const record = rate as Record<string, unknown>;
  const surchargeMinor = Number(record.surchargeMinor);
  const feeVariantGid = String(record.feeVariantGid || "").trim();
  return Number.isSafeInteger(surchargeMinor) &&
    surchargeMinor > 0 &&
    feeVariantGid.startsWith("gid://shopify/ProductVariant/")
    ? { surchargeMinor, feeVariantGid }
    : null;
}

function parseContract(
  value: unknown,
  immutableCreatorProductId: string,
): CreatorCartValidationContract | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    candidate.creatorProductId !== immutableCreatorProductId ||
    typeof candidate.feeRequired !== "boolean" ||
    !Number.isInteger(candidate.placementCount) ||
    (candidate.placementCount as number) < 1
  ) {
    return null;
  }

  if (
    candidate.feeRequired === true &&
    (typeof candidate.feeVariantId !== "string" ||
      candidate.feeVariantId.length === 0)
  ) {
    return null;
  }

  if (candidate.feeRequired === false && candidate.feeVariantId !== null) {
    return null;
  }

  return {
    version: 1,
    creatorProductId: immutableCreatorProductId,
    feeRequired: candidate.feeRequired,
    feeVariantId: candidate.feeVariantId as string | null,
    placementCount: candidate.placementCount as number,
  };
}

function sameContract(
  left: CreatorCartValidationContract,
  right: CreatorCartValidationContract,
): boolean {
  return (
    left.version === right.version &&
    left.creatorProductId === right.creatorProductId &&
    left.feeRequired === right.feeRequired &&
    left.feeVariantId === right.feeVariantId &&
    left.placementCount === right.placementCount
  );
}

export function cartValidationsGenerateRun(
  input: CartValidationsGenerateRunInput,
): CartValidationsGenerateRunResult {
  const errors: ValidationError[] = [];
  const errorMessages = new Set<string>();
  const creatorGroups = new Map<string, CreatorGroup>();
  const publicGroups = new Map<string, PublicGroup>();
  const feeGroups = new Map<string, FeeGroup>();

  const addError = (message: string) => {
    if (!errorMessages.has(message)) {
      errorMessages.add(message);
      errors.push({ message, target: TARGET });
    }
  };

  for (const line of input.cart.lines) {
    const product = productFor(line);
    const immutableCreatorProductId = metafieldValue(product?.creatorProductId);

    if (isCreatorProduct(product) && immutableCreatorProductId) {
      const creatorProductId = attributeValue(line.creatorProductIdAttribute);
      const feeKey = attributeValue(line.feeKeyAttribute);

      const nonReturnAcknowledgement =
        attributeValue(line.hiddenNonReturnAcknowledgement) ??
        attributeValue(line.nonReturnAcknowledgement);
      const termsAcknowledgement =
        attributeValue(line.hiddenTermsAcknowledgement) ??
        attributeValue(line.termsAcknowledgement);

      if (nonReturnAcknowledgement !== "Accepted") {
        addError(MESSAGES.nonReturn);
      }
      if (termsAcknowledgement !== "Accepted") {
        addError(MESSAGES.terms);
      }

      if (
        creatorProductId !== immutableCreatorProductId ||
        feeKey === null ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1
      ) {
        addError(MESSAGES.fee);
        continue;
      }

      const key = creatorFeeKey(immutableCreatorProductId, feeKey);
      const contract = parseContract(
        product.creatorCartValidation?.jsonValue,
        immutableCreatorProductId,
      );

      if (!contract) {
        addError(MESSAGES.contract);
      }

      const existing = creatorGroups.get(key);
      if (!existing) {
        creatorGroups.set(key, {
          expectedFeeQuantity: contract
            ? line.quantity * contract.placementCount
            : 0,
          contract,
        });
      } else if (
        !existing.contract ||
        !contract ||
        !sameContract(existing.contract, contract)
      ) {
        existing.contract = null;
        addError(MESSAGES.contract);
      } else {
        existing.expectedFeeQuantity +=
          line.quantity * contract.placementCount;
      }

      continue;
    }

    if (
      isPublicCustomizableProduct(product) &&
      (attributeValue(line.publicCustomizeAttribute) === "true" ||
        attributeValue(line.pitchprintAttribute) !== null ||
        attributeValue(line.publicCartValidationAttribute) !== null)
    ) {
      const productId = product.id || "";
      const parentProductId = attributeValue(line.parentProductIdAttribute);
      const feeKey = attributeValue(line.feeKeyAttribute);
      const contract = parsePublicContract(
        attributeValue(line.publicCartValidationAttribute),
      );
      const productionMethod = cleanProductionMethod(
        attributeValue(line.productionMethodAttribute),
      );
      const embroiderySubtype = cleanEmbroiderySubtype(
        attributeValue(line.embroiderySubtypeAttribute),
      );
      const placementCount = Number(
        attributeValue(line.placementCountAttribute),
      );
      const nonReturnAcknowledgement =
        attributeValue(line.hiddenNonReturnAcknowledgement) ??
        attributeValue(line.nonReturnAcknowledgement);
      const termsAcknowledgement =
        attributeValue(line.hiddenTermsAcknowledgement) ??
        attributeValue(line.termsAcknowledgement);

      if (nonReturnAcknowledgement !== "Accepted") addError(MESSAGES.nonReturn);
      if (termsAcknowledgement !== "Accepted") addError(MESSAGES.terms);

      const pricingRate = contract ? publicPricingRate(product, contract) : null;
      const validContract = Boolean(
        contract &&
          pricingRate &&
          contract.feeVariantId === pricingRate.feeVariantGid &&
          contract.productionMethod === productionMethod &&
          contract.placementCount === placementCount &&
          (productionMethod === "EMBROIDERY"
            ? contract.embroiderySubtype === embroiderySubtype
            : contract.embroiderySubtype === null && embroiderySubtype === null),
      );
      if (
        parentProductId !== productId ||
        !feeKey ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1
      ) {
        addError(MESSAGES.publicFee);
        continue;
      }
      if (!validContract || !contract || !pricingRate) {
        addError(MESSAGES.publicContract);
      }

      const key = creatorFeeKey(productId, feeKey);
      const existing = publicGroups.get(key);
      if (!existing) {
        publicGroups.set(key, {
          expectedFeeQuantity: validContract && contract
            ? line.quantity * contract.placementCount
            : 0,
          expectedFeeVariantId: validContract && pricingRate
            ? pricingRate.feeVariantGid
            : null,
          valid: validContract,
        });
      } else if (
        !validContract ||
        !pricingRate ||
        existing.expectedFeeVariantId !== pricingRate.feeVariantGid
      ) {
        existing.valid = false;
        existing.expectedFeeVariantId = null;
        addError(MESSAGES.publicContract);
      } else if (contract) {
        existing.expectedFeeQuantity += line.quantity * contract.placementCount;
      }
      continue;
    }

    const feeCreatorProductId = attributeValue(line.creatorProductIdAttribute);
    const feeParentProductId = attributeValue(line.parentProductIdAttribute);
    const feeKey = attributeValue(line.feeKeyAttribute);
    const isProductionFee =
      metafieldValue(product?.productType) === "production_fee" &&
      (feeCreatorProductId !== null || feeParentProductId !== null) &&
      feeKey !== null &&
      attributeValue(line.productionFeeAttribute) === "true";

    if (!isProductionFee || !feeKey) {
      continue;
    }

    if (
      feeCreatorProductId &&
      feeParentProductId &&
      feeCreatorProductId !== feeParentProductId
    ) {
      addError(MESSAGES.publicFee);
      continue;
    }

    const feeOwnerId = feeCreatorProductId || feeParentProductId;
    if (!feeOwnerId) continue;
    const key = creatorFeeKey(feeOwnerId, feeKey);
    const existing = feeGroups.get(key);
    const variantId =
      line.merchandise.__typename === "ProductVariant"
        ? line.merchandise.id
        : "";
    if (existing) {
      existing.quantity += line.quantity;
      existing.variantIds.push(variantId);
    } else {
      feeGroups.set(key, {
        quantity: line.quantity,
        variantIds: [variantId],
        kind: feeCreatorProductId ? "creator" : "public",
      });
    }
  }

  for (const [key, creatorGroup] of creatorGroups) {
    if (!creatorGroup.contract) {
      continue;
    }

    const feeGroup = feeGroups.get(key);
    if (!creatorGroup.contract.feeRequired) {
      if (feeGroup) {
        addError(MESSAGES.fee);
      }
      continue;
    }

    if (
      !feeGroup ||
      feeGroup.quantity !== creatorGroup.expectedFeeQuantity ||
      feeGroup.variantIds.some(
        (variantId) => variantId !== creatorGroup.contract?.feeVariantId,
      )
    ) {
      addError(MESSAGES.fee);
    }
  }

  for (const [key, publicGroup] of publicGroups) {
    if (!publicGroup.valid || !publicGroup.expectedFeeVariantId) continue;
    const feeGroup = feeGroups.get(key);
    if (
      !feeGroup ||
      feeGroup.quantity !== publicGroup.expectedFeeQuantity ||
      feeGroup.variantIds.some(
        (variantId) => variantId !== publicGroup.expectedFeeVariantId,
      )
    ) {
      addError(MESSAGES.publicFee);
    }
  }

  for (const [key, feeGroup] of feeGroups) {
    if (!creatorGroups.has(key) && !publicGroups.has(key)) {
      addError(feeGroup.kind === "creator" ? MESSAGES.fee : MESSAGES.publicFee);
    }
  }

  return { operations: [{ validationAdd: { errors } }] };
}
