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
      "CREATOR_FORBIDDEN",
      mode === "CREATOR_PUBLISH"
        ? "Only approved, active creators can add designs to a collection."
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
