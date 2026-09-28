import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

type Attribute = { value?: string | null } | null;

type Metafield = { value?: string | null; jsonValue?: unknown } | null;

type Product = {
  productOrigin?: Metafield;
  designMode?: Metafield;
  productType?: Metafield;
  creatorProductId?: Metafield;
  creatorCartValidation?: Metafield;
};

type Merchandise = {
  __typename?: string;
  id?: string;
  product?: Product;
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

type FeeGroup = {
  quantity: number;
  variantIds: string[];
};

const TARGET = "$.cart";

const MESSAGES = {
  nonReturn:
    "Please confirm that you understand this customized product cannot be returned.",
  terms: "Please accept the Terms & Conditions before continuing.",
  fee: "This Creator product's production fee is missing or invalid. Please remove it and add it again.",
  contract: "This Creator product needs to be republished before checkout.",
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

function creatorFeeKey(creatorProductId: string, feeKey: string): string {
  return `${creatorProductId.length}:${creatorProductId}${feeKey}`;
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

      if (attributeValue(line.nonReturnAcknowledgement) !== "Accepted") {
        addError(MESSAGES.nonReturn);
      }
      if (attributeValue(line.termsAcknowledgement) !== "Accepted") {
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

    const feeCreatorProductId = attributeValue(
      line.creatorProductIdAttribute,
    );
    const feeKey = attributeValue(line.feeKeyAttribute);
    const isCreatorFee =
      metafieldValue(product?.productType) === "production_fee" &&
      feeCreatorProductId !== null &&
      feeKey !== null &&
      attributeValue(line.productionFeeAttribute) === "true";

    if (!isCreatorFee || !feeCreatorProductId || !feeKey) {
      continue;
    }

    const key = creatorFeeKey(feeCreatorProductId, feeKey);
    const existing = feeGroups.get(key);
    const variantId = line.merchandise.id ?? "";
    if (existing) {
      existing.quantity += line.quantity;
      existing.variantIds.push(variantId);
    } else {
      feeGroups.set(key, {
        quantity: line.quantity,
        variantIds: [variantId],
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

  for (const key of feeGroups.keys()) {
    if (!creatorGroups.has(key)) {
      addError(MESSAGES.fee);
    }
  }

  return { operations: [{ validationAdd: { errors } }] };
}
