import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  removeCreatorCollectionBanner,
  updateCreatorCollectionBanner,
  uploadCollectionBannerImage,
  validateCollectionBannerImage,
} from "../app/services/creator-collection-banner.server.ts";
import type { ShopifyGraphqlClient } from "../app/services/shopify-graphql.server.ts";

function pngBytes(width = 1920, height = 600) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function bannerDb() {
  const auditActions: string[] = [];
  const collection = {
    id: "collection-a",
    shop: "customhouse.test",
    creatorId: "creator-a",
    publicHandle: "ari-designs",
    bannerImageUrl: null as string | null,
    bannerTitle: null as string | null,
    bannerSubtitle: null as string | null,
    bannerUpdatedAt: null as Date | null,
  };
  return {
    collection,
    auditActions,
    creator: {
      async findUnique(args: {
        where: { shop_customerId: { shop: string; customerId: string } };
      }) {
        assert.deepEqual(args.where.shop_customerId, {
          shop: "customhouse.test",
          customerId: "gid://shopify/Customer/111",
        });
        return {
          id: "creator-a",
          shop: "customhouse.test",
          customerId: "gid://shopify/Customer/111",
          status: "APPROVED",
        };
      },
    },
    creatorCollection: {
      async findFirst(args: {
        where: { shop: string; creatorId: string };
      }) {
        assert.deepEqual(args.where, {
          shop: "customhouse.test",
          creatorId: "creator-a",
        });
        return collection;
      },
      async update(args: {
        where: { id: string };
        data: {
          bannerImageUrl?: string | null;
          bannerTitle?: string | null;
          bannerSubtitle?: string | null;
          bannerUpdatedAt?: Date | null;
        };
      }) {
        assert.equal(args.where.id, "collection-a");
        Object.assign(collection, args.data);
        return collection;
      },
    },
    auditLog: {
      async create(args: { data: { action: string; actorId: string } }) {
        assert.equal(args.data.actorId, "gid://shopify/Customer/111");
        auditActions.push(args.data.action);
        return {};
      },
    },
  };
}

test("collection banner validation accepts wide PNG banners and rejects mismatched files", () => {
  assert.deepEqual(
    validateCollectionBannerImage(
      pngBytes(),
      "image/png",
      24,
      "banner.png",
    ),
    { mimeType: "image/png", width: 1920, height: 600 },
  );
  assert.throws(
    () =>
      validateCollectionBannerImage(
        pngBytes(),
        "image/jpeg",
        24,
        "banner.jpg",
      ),
    /image type does not match/i,
  );
});

test("collection banner upload stores Shopify media and returns a display URL", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const client: ShopifyGraphqlClient = {
    async request<T>(query: string) {
      requests.push(query);
      if (query.includes("stagedUploadsCreate")) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://uploads.shopify.test/banner",
                resourceUrl: "https://cdn.shopify.test/staged/banner.png",
                parameters: [{ name: "key", value: "banner.png" }],
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      if (query.includes("fileCreate")) {
        return {
          fileCreate: {
            files: [
              {
                id: "gid://shopify/MediaImage/999",
                fileStatus: "READY",
                image: { url: "https://cdn.shopify.test/banner.png" },
              },
            ],
            userErrors: [],
          },
        } as T;
      }
      throw new Error("Unexpected query");
    },
  };

  try {
    const uploaded = await uploadCollectionBannerImage(
      new File([pngBytes()], "banner.png", { type: "image/png" }),
      client,
      "Ari collection banner",
    );

    assert.equal(uploaded.bannerImageUrl, "https://cdn.shopify.test/banner.png");
    assert.equal(uploaded.bannerImageId, "gid://shopify/MediaImage/999");
    assert.equal(uploaded.status, "READY");
    assert.equal(requests.some((query) => query.includes("stagedUploadsCreate")), true);
    assert.equal(requests.some((query) => query.includes("fileCreate")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated creator can update only their own collection banner", async () => {
  const database = bannerDb();
  const updated = await updateCreatorCollectionBanner({
    shop: "customhouse.test",
    customerId: "111",
    title: "Summer drop",
    subtitle: "Limited pieces from Ari",
    bannerImageUrl: "https://cdn.shopify.test/banner.png",
    database,
  });

  assert.equal(updated.bannerImageUrl, "https://cdn.shopify.test/banner.png");
  assert.equal(updated.bannerTitle, "Summer drop");
  assert.equal(updated.bannerSubtitle, "Limited pieces from Ari");
  assert.ok(updated.bannerUpdatedAt instanceof Date);
  assert.deepEqual(database.auditActions, ["creator_collection.banner.updated"]);
});

test("remove banner clears the complete banner configuration for the authenticated creator", async () => {
  const database = bannerDb();
  database.collection.bannerImageUrl = "https://cdn.shopify.test/banner.png";
  database.collection.bannerTitle = "Summer drop";
  database.collection.bannerSubtitle = "Limited pieces from Ari";
  database.collection.bannerUpdatedAt = new Date();

  const updated = await removeCreatorCollectionBanner({
    shop: "customhouse.test",
    customerId: "111",
    database,
  });

  assert.equal(updated.bannerImageUrl, null);
  assert.equal(updated.bannerTitle, null);
  assert.equal(updated.bannerSubtitle, null);
  assert.equal(updated.bannerUpdatedAt, null);
  assert.deepEqual(database.auditActions, ["creator_collection.banner.removed"]);
});

test("creator banner proxy route uses app proxy auth and never accepts browser creatorId", () => {
  const route = readFileSync(
    "app/routes/proxy.api.creator-collection-banner.tsx",
    "utf8",
  );

  assert.match(route, /proxyContext\(request\)/);
  assert.match(route, /creatorCollectionBannerForCustomer/);
  assert.match(route, /updateCreatorCollectionBanner/);
  assert.match(route, /removeCreatorCollectionBanner/);
  assert.match(route, /bannerImage/);
  assert.doesNotMatch(route, /creatorId/);
  assert.doesNotMatch(route, /searchParams\.get\(["']creatorId["']\)/);
  assert.doesNotMatch(route, /form\.get\(["']creatorId["']\)/);
});

test("creator dashboard response exposes collection banner fields", () => {
  const dashboardService = readFileSync("app/services/submission.server.ts", "utf8");

  assert.match(dashboardService, /bannerImageUrl: true/);
  assert.match(dashboardService, /bannerTitle: true/);
  assert.match(dashboardService, /bannerSubtitle: true/);
  assert.match(dashboardService, /bannerUpdatedAt: true/);
  assert.match(dashboardService, /bannerUpdatedAt: creator\.marketplaceCollection\.bannerUpdatedAt/);
});

test("creator dashboard renders compact collection banner management UI", () => {
  const block = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );
  const script = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js",
    "utf8",
  );
  const styles = readFileSync(
    "extensions/customhouse-creator-storefront/assets/customhouse.css",
    "utf8",
  );

  assert.match(block, /customhouse-collection-banner-manager/);
  assert.match(block, /data-dashboard-banner-form/);
  assert.match(block, /data-dashboard-banner-preview/);
  assert.match(block, /name="bannerImage"/);
  assert.match(block, /name="bannerTitle"/);
  assert.match(block, /name="bannerSubtitle"/);
  assert.match(block, /Recommended size: 1920 x 600 px/);
  assert.match(block, /data-dashboard-banner-remove/);
  assert.match(block, /data-dashboard-action-modal/);

  assert.match(script, /COLLECTION_BANNER_ENDPOINT/);
  assert.match(script, /function hydrateCollectionBannerManager/);
  assert.match(script, /function bindCollectionBannerManager/);
  assert.match(script, /saveCollectionBanner/);
  assert.match(script, /removeCollectionBanner/);
  assert.match(script, /data-dashboard-banner-preview-image/);
  assert.match(script, /openDashboardActionModal/);
  assert.match(script, /Collection banner removed/);
  assert.doesNotMatch(script, /alert\(/);

  assert.match(styles, /\.customhouse-collection-banner-manager/);
  assert.match(styles, /\.customhouse-banner-preview\s*\{[^}]*aspect-ratio: 3\.2 \/ 1/s);
  assert.match(styles, /\.customhouse-banner-preview img\s*\{[^}]*object-fit: cover/s);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.customhouse-banner-actions/s);
});

test("public creator collection loads and renders an optional banner without changing fallback hero", () => {
  const collectionsService = readFileSync(
    "app/services/creator-collections.server.ts",
    "utf8",
  );
  const storefront = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );

  assert.match(collectionsService, /bannerImageUrl: true/);
  assert.match(collectionsService, /bannerTitle: true/);
  assert.match(collectionsService, /bannerSubtitle: true/);
  assert.match(collectionsService, /bannerUpdatedAt: true/);
  assert.match(storefront, /function collectionBannerHtml/);
  assert.match(storefront, /customhouse-public-banner/);
  assert.match(storefront, /object-fit:cover/);
  assert.match(storefront, /collectionBannerHtml\(input\)/);
  assert.match(storefront, /bannerTitle/);
  assert.match(storefront, /\$\{input\.creator\.displayName\} collection banner/);
  assert.match(storefront, /<header class="customhouse-public-hero">/);
});

test("public creator collection JSON exposes banner fields only from the loaded collection", () => {
  const storefront = readFileSync(
    "app/services/storefront-proxy.server.ts",
    "utf8",
  );

  assert.match(storefront, /bannerImageUrl: collection\.bannerImageUrl/);
  assert.match(storefront, /bannerTitle: collection\.bannerTitle/);
  assert.match(storefront, /bannerSubtitle: collection\.bannerSubtitle/);
  assert.match(storefront, /bannerUpdatedAt: collection\.bannerUpdatedAt/);
});

test("admin creator list and detail expose read-only collection banner status", () => {
  const route = readFileSync("app/routes/app.creators.tsx", "utf8");
  const styles = readFileSync("app/styles/admin.css", "utf8");

  assert.match(route, /marketplaceCollection:\s*\{\s*select:\s*\{/);
  assert.match(route, /bannerImageUrl: true/);
  assert.match(route, /bannerTitle: true/);
  assert.match(route, /bannerSubtitle: true/);
  assert.match(route, /bannerUpdatedAt: true/);
  assert.match(route, /Collection Banner/);
  assert.match(route, /creator-banner-preview/);
  assert.match(route, /Banner configured/);
  assert.match(route, /No banner/);
  assert.doesNotMatch(route, /name="bannerImage"/);
  assert.match(styles, /\.creator-banner-preview/);
});
