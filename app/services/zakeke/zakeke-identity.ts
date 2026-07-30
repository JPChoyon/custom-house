import { DomainError } from "../domain.ts";
import type { ZakekeIdentity } from "./zakeke-types.ts";

export function zakekeIdentityForPrincipal(
  principal: string,
): ZakekeIdentity {
  const customer = principal.match(
    /^gid:\/\/shopify\/Customer\/([0-9]+)$/,
  )?.[1];
  if (customer) return { customerCode: `shopify-${customer}` };
  const visitor = principal.match(/^visitor:([A-Za-z0-9_-]{20,100})$/)?.[1];
  if (visitor) return { visitorCode: visitor };
  throw new DomainError(
    "DESIGNER_IDENTITY_INVALID",
    "The designer identity is invalid.",
    401,
  );
}
