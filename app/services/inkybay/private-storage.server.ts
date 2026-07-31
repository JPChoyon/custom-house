import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "../domain";
import { getPrivateStorageConfig } from "./inkybay-config.server";

function client() {
  const config = getPrivateStorageConfig();
  return {
    config,
    s3: new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
  };
}

function segment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "unknown";
}

export async function storePrivateProductionArtwork(input: {
  shop: string;
  creatorId: string;
  sessionId: string;
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}) {
  const { config, s3 } = client();
  const key = [
    "creator-production",
    segment(input.shop),
    segment(input.creatorId),
    segment(input.sessionId),
    `${randomUUID()}.${segment(input.extension)}`,
  ].join("/");
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: input.mimeType,
        CacheControl: "private, no-store",
        ServerSideEncryption: "AES256",
        Metadata: {
          purpose: "creator-production-artwork",
        },
      }),
    );
  } catch {
    throw new DomainError(
      "PRODUCTION_ARTWORK_STORAGE_FAILED",
      "The production artwork could not be stored. Please try again.",
      502,
    );
  }
  return { key };
}

export async function signPrivateProductionDownload(
  key: string,
  lifetimeSeconds = 5 * 60,
) {
  const { config, s3 } = client();
  if (!key.startsWith("creator-production/")) {
    throw new DomainError(
      "PRODUCTION_ARTWORK_INVALID",
      "The production artwork reference is invalid.",
      422,
    );
  }
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      { expiresIn: Math.max(60, Math.min(lifetimeSeconds, 15 * 60)) },
    );
  } catch {
    throw new DomainError(
      "PRODUCTION_ARTWORK_UNAVAILABLE",
      "The production artwork is temporarily unavailable.",
      503,
    );
  }
}
