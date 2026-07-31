import { DomainError } from "../domain";

export type PrivateStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

function positiveInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}

export function getInkyBayFeatureFlags() {
  return {
    creatorPublishing:
      process.env.INKYBAY_CREATOR_PUBLISHING_ENABLED === "true",
    customCallback:
      process.env.INKYBAY_CUSTOM_CALLBACK_ENABLED === "true",
    manualBridge:
      process.env.INKYBAY_MANUAL_PUBLISH_BRIDGE_ENABLED === "true",
  };
}

export function getInkyBayLimits() {
  return {
    sessionTtlSeconds: positiveInteger(
      "INKYBAY_SESSION_TTL_SECONDS",
      2 * 60 * 60,
      24 * 60 * 60,
    ),
    productionMaximumBytes: positiveInteger(
      "INKYBAY_PRODUCTION_MAX_BYTES",
      25 * 1024 * 1024,
      100 * 1024 * 1024,
    ),
    productionMinimumWidth: positiveInteger(
      "INKYBAY_PRODUCTION_MIN_WIDTH",
      2_000,
      20_000,
    ),
    productionMinimumHeight: positiveInteger(
      "INKYBAY_PRODUCTION_MIN_HEIGHT",
      2_000,
      20_000,
    ),
  };
}

export function getPrivateStorageConfig(): PrivateStorageConfig {
  const endpoint = process.env.PRIVATE_STORAGE_ENDPOINT?.trim() || "";
  const region = process.env.PRIVATE_STORAGE_REGION?.trim() || "";
  const bucket = process.env.PRIVATE_STORAGE_BUCKET?.trim() || "";
  const accessKeyId =
    process.env.PRIVATE_STORAGE_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey =
    process.env.PRIVATE_STORAGE_SECRET_ACCESS_KEY?.trim() || "";
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new DomainError(
      "PRIVATE_STORAGE_NOT_CONFIGURED",
      "Private production artwork storage is not configured.",
      503,
    );
  }
  if (
    endpointUrl.protocol !== "https:" ||
    endpointUrl.username ||
    endpointUrl.password ||
    !region ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new DomainError(
      "PRIVATE_STORAGE_NOT_CONFIGURED",
      "Private production artwork storage is not configured.",
      503,
    );
  }
  return {
    endpoint: endpointUrl.toString(),
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.PRIVATE_STORAGE_FORCE_PATH_STYLE === "true",
  };
}

export function inkyBayConfigurationSummary() {
  const flags = getInkyBayFeatureFlags();
  const storageNames = [
    "PRIVATE_STORAGE_ENDPOINT",
    "PRIVATE_STORAGE_REGION",
    "PRIVATE_STORAGE_BUCKET",
    "PRIVATE_STORAGE_ACCESS_KEY_ID",
    "PRIVATE_STORAGE_SECRET_ACCESS_KEY",
  ];
  return {
    ...flags,
    privateStorageConfigured: storageNames.every((name) =>
      Boolean(process.env[name]?.trim()),
    ),
    callbackSecretConfigured: Boolean(
      process.env.INKYBAY_CREATOR_CALLBACK_SECRET?.trim(),
    ),
    callbackOriginConfigured: Boolean(
      process.env.INKYBAY_CREATOR_CALLBACK_ALLOWED_ORIGIN?.trim(),
    ),
  };
}
