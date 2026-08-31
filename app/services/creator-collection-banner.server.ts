import db from "../db.server.ts";
import { DomainError, safeJson } from "./domain.ts";
import { validateImageUpload } from "./designer-validation.ts";
import { normalizeCustomerGid } from "./helium-sync.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server.ts";
import { throwUserErrors } from "./shopify-graphql.server.ts";

type UserError = { message: string };
type BannerImageMedia = {
  id: string;
  fileStatus: string;
  image?: { url: string } | null;
};

type BannerCollection = {
  id: string;
  shop: string;
  creatorId: string;
  publicHandle: string;
  bannerImageUrl: string | null;
  bannerTitle: string | null;
  bannerSubtitle: string | null;
  bannerUpdatedAt: Date | null;
};

type BannerDb = {
  creator: {
    findUnique(args: unknown): Promise<{
      id: string;
      shop: string;
      customerId: string;
      status: string;
    } | null>;
  };
  creatorCollection: {
    findFirst(args: unknown): Promise<BannerCollection | null>;
    update(args: unknown): Promise<BannerCollection>;
  };
  auditLog?: {
    create(args: unknown): Promise<unknown>;
  };
};

export function validateCollectionBannerImage(
  bytes: Uint8Array,
  mimeType: string,
  size: number,
  fileName: string,
) {
  return validateImageUpload(bytes, fileName, mimeType, {
    maximumBytes: 8 * 1024 * 1024,
    minimumWidth: 600,
    minimumHeight: 188,
    allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  });
}

async function bannerImageUrl(mediaId: string, client: ShopifyGraphqlClient) {
  const result = await client.request<{
    bannerImage: BannerImageMedia | null;
  }>(
    `#graphql query CreatorCollectionBannerImage($id: ID!) {
      bannerImage: node(id: $id) {
        ... on MediaImage {
          id
          fileStatus
          image { url }
        }
      }
    }`,
    { id: mediaId },
  );
  return result.bannerImage?.image?.url || null;
}

async function waitForBannerImageUrl(
  mediaId: string,
  client: ShopifyGraphqlClient,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const imageUrl = await bannerImageUrl(mediaId, client);
    if (imageUrl) return imageUrl;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return null;
}

export async function uploadCollectionBannerImage(
  file: File,
  client: ShopifyGraphqlClient,
  alt = "Creator collection banner",
) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateCollectionBannerImage(bytes, file.type, file.size, file.name);
  const staged = await client.request<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: UserError[];
    };
  }>(
    `#graphql mutation CreatorCollectionBannerTarget($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }`,
    {
      input: [
        {
          resource: "IMAGE",
          filename: file.name.slice(0, 120),
          mimeType: file.type,
          fileSize: String(file.size),
          httpMethod: "POST",
        },
      ],
    },
  );
  throwUserErrors(
    staged.stagedUploadsCreate.userErrors,
    "Collection banner upload preparation",
  );
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    throw new DomainError(
      "UPLOAD_FAILED",
      "Collection banner upload could not be prepared.",
      502,
    );
  }
  const form = new FormData();
  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }
  form.append("file", new Blob([bytes], { type: file.type }), file.name);
  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new DomainError(
      "UPLOAD_FAILED",
      "Collection banner upload failed.",
      502,
    );
  }
  const created = await client.request<{
    fileCreate: { files: BannerImageMedia[]; userErrors: UserError[] };
  }>(
    `#graphql mutation CreatorCollectionBannerCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage {
            id
            fileStatus
            image { url }
          }
        }
        userErrors { message }
      }
    }`,
    {
      files: [
        {
          originalSource: target.resourceUrl,
          contentType: "IMAGE",
          alt: cleanBannerText(alt, 120) || "Creator collection banner",
        },
      ],
    },
  );
  throwUserErrors(created.fileCreate.userErrors, "Collection banner creation");
  const media = created.fileCreate.files[0];
  if (!media) {
    throw new DomainError(
      "UPLOAD_FAILED",
      "Shopify did not create the collection banner image.",
      502,
    );
  }
  return {
    bannerImageId: media.id,
    bannerImageUrl:
      media.image?.url || (await waitForBannerImageUrl(media.id, client)),
    status: media.fileStatus,
  };
}

function cleanBannerText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const withoutControlCharacters = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const normalized = withoutControlCharacters.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function cleanHttpsUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function approvedCreatorCollection(
  input: {
    shop: string;
    customerId: string;
    database?: BannerDb;
  },
) {
  const database = input.database || db;
  const customerId = normalizeCustomerGid(input.customerId);
  const creator = await database.creator.findUnique({
    where: {
      shop_customerId: {
        shop: input.shop,
        customerId,
      },
    },
  });
  if (!creator) {
    throw new DomainError(
      "CREATOR_NOT_FOUND",
      "Creator profile not found.",
      404,
    );
  }
  if (creator.status !== "APPROVED") {
    throw new DomainError(
      "CREATOR_NOT_APPROVED",
      "Only approved creators can manage a collection banner.",
      403,
    );
  }
  const collection = await database.creatorCollection.findFirst({
    where: {
      shop: input.shop,
      creatorId: creator.id,
    },
  });
  if (!collection) {
    throw new DomainError(
      "CREATOR_COLLECTION_NOT_FOUND",
      "Creator collection not found.",
      404,
    );
  }
  return { database, customerId, creator, collection };
}

export async function creatorCollectionBannerForCustomer(input: {
  shop: string;
  customerId: string;
  database?: BannerDb;
}) {
  const { collection } = await approvedCreatorCollection(input);
  return collection;
}

export async function updateCreatorCollectionBanner(input: {
  shop: string;
  customerId: string;
  title?: unknown;
  subtitle?: unknown;
  bannerImageUrl?: unknown;
  database?: BannerDb;
}) {
  const { database, customerId, creator, collection } =
    await approvedCreatorCollection(input);
  const nextImageUrl = cleanHttpsUrl(input.bannerImageUrl);
  const updated = await database.creatorCollection.update({
    where: { id: collection.id },
    data: {
      ...(nextImageUrl !== undefined ? { bannerImageUrl: nextImageUrl } : {}),
      bannerTitle: cleanBannerText(input.title, 120),
      bannerSubtitle: cleanBannerText(input.subtitle, 500),
      bannerUpdatedAt: new Date(),
    },
  });
  await database.auditLog?.create({
    data: {
      shop: input.shop,
      actorType: "CUSTOMER",
      actorId: customerId,
      action: "creator_collection.banner.updated",
      entityType: "CreatorCollection",
      entityId: collection.id,
      beforeJson: safeJson({
        hasBanner: Boolean(collection.bannerImageUrl),
        titlePresent: Boolean(collection.bannerTitle),
        subtitlePresent: Boolean(collection.bannerSubtitle),
      }),
      afterJson: safeJson({
        creatorId: creator.id,
        hasBanner: Boolean(updated.bannerImageUrl),
        titlePresent: Boolean(updated.bannerTitle),
        subtitlePresent: Boolean(updated.bannerSubtitle),
      }),
    },
  });
  return updated;
}

export async function removeCreatorCollectionBanner(input: {
  shop: string;
  customerId: string;
  database?: BannerDb;
}) {
  const { database, customerId, collection } =
    await approvedCreatorCollection(input);
  const updated = await database.creatorCollection.update({
    where: { id: collection.id },
    data: {
      bannerImageUrl: null,
      bannerTitle: null,
      bannerSubtitle: null,
      bannerUpdatedAt: null,
    },
  });
  await database.auditLog?.create({
    data: {
      shop: input.shop,
      actorType: "CUSTOMER",
      actorId: customerId,
      action: "creator_collection.banner.removed",
      entityType: "CreatorCollection",
      entityId: collection.id,
      beforeJson: safeJson({
        hasBanner: Boolean(collection.bannerImageUrl),
        titlePresent: Boolean(collection.bannerTitle),
        subtitlePresent: Boolean(collection.bannerSubtitle),
      }),
    },
  });
  return updated;
}
