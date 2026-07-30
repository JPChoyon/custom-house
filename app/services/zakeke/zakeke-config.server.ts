import { DomainError } from "../domain.ts";

const DEFAULT_API_BASE_URL = "https://api.zakeke.com";
const DEFAULT_CUSTOMIZER_SCRIPT =
  "https://portal.zakeke.com/scripts/integration/apiV2/customizer.js";

function enabled(name: string) {
  return process.env[name] === "true";
}

function safeHttpsUrl(name: string, fallback: string) {
  const raw = process.env[name]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError(
      "ZAKEKE_NOT_CONFIGURED",
      "The Zakeke service URL is invalid.",
      503,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DomainError(
      "ZAKEKE_NOT_CONFIGURED",
      "The Zakeke service URL is invalid.",
      503,
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function getZakekeFeatureFlags() {
  return {
    integration: enabled("ZAKEKE_INTEGRATION_ENABLED"),
    creatorPublishing: enabled("ZAKEKE_CREATOR_PUBLISHING_ENABLED"),
    fixedPurchase: enabled("ZAKEKE_FIXED_PURCHASE_ENABLED"),
  };
}

export function getZakekePublicConfiguration() {
  return {
    apiBaseUrl: safeHttpsUrl("ZAKEKE_API_BASE_URL", DEFAULT_API_BASE_URL),
    customizerScriptUrl: DEFAULT_CUSTOMIZER_SCRIPT,
    testShopifyProductId:
      process.env.ZAKEKE_TEST_SHOPIFY_PRODUCT_ID?.trim() || null,
    testProductCode: process.env.ZAKEKE_TEST_PRODUCT_CODE?.trim() || null,
    flags: getZakekeFeatureFlags(),
  };
}

export function requireZakekeCredentials() {
  const clientId = process.env.ZAKEKE_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.ZAKEKE_CLIENT_SECRET?.trim() || "";
  if (!clientId || !clientSecret) {
    throw new DomainError(
      "ZAKEKE_NOT_CONFIGURED",
      "Zakeke API credentials are not configured.",
      503,
    );
  }
  return {
    clientId,
    clientSecret,
    apiBaseUrl: safeHttpsUrl("ZAKEKE_API_BASE_URL", DEFAULT_API_BASE_URL),
  };
}

export function requireZakekeSecret(
  name:
    | "ZAKEKE_TOKEN_ENCRYPTION_SECRET"
    | "DESIGN_PURCHASE_SIGNING_SECRET",
) {
  const value = process.env[name]?.trim() || "";
  if (value.length < 32) {
    throw new DomainError(
      "ZAKEKE_NOT_CONFIGURED",
      "Zakeke request signing is not configured.",
      503,
    );
  }
  return value;
}

export function zakekeConnectionSummary() {
  const flags = getZakekeFeatureFlags();
  return {
    ...flags,
    adminDiagnostics:
      process.env.ZAKEKE_ADMIN_DIAGNOSTICS_ENABLED === "true",
    credentialsConfigured: Boolean(
      process.env.ZAKEKE_CLIENT_ID?.trim() &&
        process.env.ZAKEKE_CLIENT_SECRET?.trim(),
    ),
    sessionSigningConfigured:
      (process.env.ZAKEKE_TOKEN_ENCRYPTION_SECRET?.trim().length ?? 0) >= 32,
    purchaseSigningConfigured:
      (process.env.DESIGN_PURCHASE_SIGNING_SECRET?.trim().length ?? 0) >= 32,
    testProductConfigured: Boolean(
      process.env.ZAKEKE_TEST_SHOPIFY_PRODUCT_ID?.trim() &&
        process.env.ZAKEKE_TEST_PRODUCT_CODE?.trim(),
    ),
  };
}
