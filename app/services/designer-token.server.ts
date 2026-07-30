import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "./domain.ts";

export type DesignCartTokenPayload = {
  designId: string;
  version: number;
  shop: string;
  productId: string;
  variantId: string;
  expiresAt: number;
};

function secret() {
  const value = process.env.DESIGN_SIGNING_SECRET;
  if (!value || value.length < 32) {
    throw new DomainError(
      "DESIGNER_NOT_CONFIGURED",
      "Product customization is not configured.",
      503,
    );
  }
  return value;
}

export function signDesignCartToken(
  payload: Omit<DesignCartTokenPayload, "expiresAt">,
  lifetimeSeconds = 15 * 60,
) {
  const value: DesignCartTokenPayload = {
    ...payload,
    expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyDesignCartToken(token: string): DesignCartTokenPayload {
  const [encoded, supplied] = token.split(".");
  if (!encoded || !supplied) {
    throw new DomainError("DESIGN_TOKEN_INVALID", "The design link is invalid.", 401);
  }
  const expected = createHmac("sha256", secret()).update(encoded).digest("base64url");
  const valid =
    supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    throw new DomainError("DESIGN_TOKEN_INVALID", "The design link is invalid.", 401);
  }
  let payload: DesignCartTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new DomainError("DESIGN_TOKEN_INVALID", "The design link is invalid.", 401);
  }
  if (!payload.expiresAt || payload.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new DomainError("DESIGN_TOKEN_EXPIRED", "The design link has expired.", 401);
  }
  return payload;
}
