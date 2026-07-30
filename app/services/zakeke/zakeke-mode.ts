import { DomainError } from "../domain.ts";
import type {
  AuthorizedDesignerMode,
  StorefrontActor,
} from "../storefront-actor.ts";

export type ZakekeDesignerMode = AuthorizedDesignerMode;

export function parseZakekeDesignerIntent(
  value: string | null,
): ZakekeDesignerMode {
  if (value === "customer_buy") return "CUSTOMER_BUY";
  if (value === "creator_buy") return "CREATOR_BUY";
  if (value === "creator_publish") return "CREATOR_PUBLISH";
  throw new DomainError(
    "DESIGNER_MODE_INVALID",
    "The requested designer mode is invalid.",
    400,
  );
}

export function authorizeZakekeMode(
  actor: StorefrontActor,
  mode: ZakekeDesignerMode,
) {
  if (!actor.authorizedDesignerModes.includes(mode)) {
    throw new DomainError(
      mode === "CREATOR_PUBLISH"
        ? "CREATOR_NOT_APPROVED"
        : "CREATOR_FORBIDDEN",
      mode === "CREATOR_PUBLISH"
        ? "Only approved creators can add designs to a collection."
        : "This creator purchase mode is not available.",
      403,
    );
  }
  return mode;
}

export function isZakekePurchaseMode(mode: ZakekeDesignerMode) {
  return mode === "CUSTOMER_BUY" || mode === "CREATOR_BUY";
}

export function zakekeCallbackDestination(
  mode: ZakekeDesignerMode,
) {
  return isZakekePurchaseMode(mode) ? "cart" : "publish";
}

export function zakekeCartButtonText(mode: ZakekeDesignerMode) {
  return mode === "CREATOR_PUBLISH"
    ? "Add to My Collection"
    : "Add to Cart";
}

export function zakekeProductActions(
  actor: StorefrontActor,
  creatorPublishingEnabled: boolean,
) {
  const creatorPublishAvailable =
    actor.isApprovedCreator && creatorPublishingEnabled;
  return {
    customerBuyAvailable: true,
    customerMode: actor.isApprovedCreator
      ? ("CREATOR_BUY" as const)
      : ("CUSTOMER_BUY" as const),
    customerButtonText: creatorPublishAvailable
      ? "Customize & Buy"
      : "Customize This Product",
    creatorPublishAvailable,
    creatorButtonText: creatorPublishAvailable
      ? "Create for My Collection"
      : null,
  };
}
