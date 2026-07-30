import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { DomainError } from "../domain.ts";
import { requireZakekeSecret } from "./zakeke-config.server.ts";
import type { ZakekeDesignerMode } from "./zakeke-mode.ts";

export type ZakekeDesignerSessionPayload = {
  sessionId: string;
  shop: string;
  productId: string;
  variantId: string;
  mode: ZakekeDesignerMode;
  principal: string;
  creatorId?: string;
  nonce: string;
  expiresAt: number;
};

export type DesignPurchaseTokenPayload = {
  purchaseId: string;
  shop: string;
  productId: string;
  variantId: string;
  principal: string;
  expiresAt: number;
};

function signature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sign(value: Record<string, unknown>, secret: string) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

function verify(
  token: string,
  secret: string,
  options: { allowExpired?: boolean } = {},
) {
  if (token.length > 8_000) {
    throw new DomainError(
      "SIGNED_TOKEN_INVALID",
      "The signed request is invalid.",
      401,
    );
  }
  const [encoded, supplied, ...rest] = token.split(".");
  if (!encoded || !supplied || rest.length) {
    throw new DomainError(
      "SIGNED_TOKEN_INVALID",
      "The signed request is invalid.",
      401,
    );
  }
  const expected = signature(encoded, secret);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new DomainError(
      "SIGNED_TOKEN_INVALID",
      "The signed request is invalid.",
      401,
    );
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.expiresAt !== "number") {
      throw new DomainError(
        "SIGNED_TOKEN_INVALID",
        "The signed request is invalid.",
        401,
      );
    }
    if (
      !options.allowExpired &&
      payload.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      throw new DomainError(
        "SIGNED_TOKEN_EXPIRED",
        "The signed request has expired.",
        401,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "SIGNED_TOKEN_INVALID",
      "The signed request is invalid.",
      401,
    );
  }
}

function requiredString(
  payload: Record<string, unknown>,
  name: string,
  pattern?: RegExp,
) {
  const value = payload[name];
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 500 ||
    (pattern && !pattern.test(value))
  ) {
    throw new DomainError(
      "SIGNED_TOKEN_INVALID",
      "The signed request is invalid.",
      401,
    );
  }
  return value;
}

export function newZakekeNonce() {
  return randomBytes(24).toString("base64url");
}

export function hashOpaqueValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function signZakekeDesignerSession(
  payload: ZakekeDesignerSessionPayload,
) {
  return sign(
    payload,
    requireZakekeSecret("ZAKEKE_TOKEN_ENCRYPTION_SECRET"),
  );
}

export function verifyZakekeDesignerSession(
  token: string,
): ZakekeDesignerSessionPayload {
  const payload = verify(
    token,
    requireZakekeSecret("ZAKEKE_TOKEN_ENCRYPTION_SECRET"),
  );
  const mode = requiredString(payload, "mode");
  if (
    mode !== "CUSTOMER_BUY" &&
    mode !== "CREATOR_BUY" &&
    mode !== "CREATOR_PUBLISH"
  ) {
    throw new DomainError(
      "SIGNED_TOKEN_INVALID",
      "The signed request is invalid.",
      401,
    );
  }
  return {
    sessionId: requiredString(payload, "sessionId"),
    shop: requiredString(payload, "shop"),
    productId: requiredString(
      payload,
      "productId",
      /^gid:\/\/shopify\/Product\/\d+$/,
    ),
    variantId: requiredString(
      payload,
      "variantId",
      /^gid:\/\/shopify\/ProductVariant\/\d+$/,
    ),
    mode,
    principal: requiredString(payload, "principal"),
    creatorId:
      typeof payload.creatorId === "string"
        ? requiredString(payload, "creatorId")
        : undefined,
    nonce: requiredString(payload, "nonce"),
    expiresAt: payload.expiresAt as number,
  };
}

export function signDesignPurchaseToken(
  payload: DesignPurchaseTokenPayload,
) {
  return sign(
    payload,
    requireZakekeSecret("DESIGN_PURCHASE_SIGNING_SECRET"),
  );
}

export function verifyDesignPurchaseToken(
  token: string,
  options: { allowExpired?: boolean } = {},
): DesignPurchaseTokenPayload {
  const payload = verify(
    token,
    requireZakekeSecret("DESIGN_PURCHASE_SIGNING_SECRET"),
    options,
  );
  return {
    purchaseId: requiredString(payload, "purchaseId"),
    shop: requiredString(payload, "shop"),
    productId: requiredString(
      payload,
      "productId",
      /^gid:\/\/shopify\/Product\/\d+$/,
    ),
    variantId: requiredString(
      payload,
      "variantId",
      /^gid:\/\/shopify\/ProductVariant\/\d+$/,
    ),
    principal: requiredString(payload, "principal"),
    expiresAt: payload.expiresAt as number,
  };
}
