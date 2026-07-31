import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseCompatibleVariantIds,
  parseInkyBaySavedDesign,
  validateProductionArtwork,
} from "../app/services/inkybay/inkybay-validation.ts";
import {
  signInkyBaySessionToken,
  verifyInkyBaySessionToken,
} from "../app/services/inkybay/inkybay-session-token.server.ts";
import { inkyBayWorkspaceHtml } from "../app/services/inkybay/inkybay-workspace.server.ts";

process.env.DESIGN_SIGNING_SECRET = "i".repeat(48);

test("saved InkyBay URL extracts a tid from an allowlisted HTTPS host", () => {
  assert.deepEqual(
    parseInkyBaySavedDesign({
      savedDesignUrl:
        "https://customhouse.se/products/shirt?tid=design_12345#ignored",
      allowedHosts: ["customhouse.se", "inkybay.com"],
    }),
    {
      savedDesignUrl: "https://customhouse.se/products/shirt?tid=design_12345",
      tid: "design_12345",
    },
  );
});

test("saved design validation rejects unsafe hosts, schemes and mismatched tids", () => {
  assert.throws(() =>
    parseInkyBaySavedDesign({
      savedDesignUrl: "http://customhouse.se/design?tid=design_12345",
      allowedHosts: ["customhouse.se"],
    }),
  );
  assert.throws(() =>
    parseInkyBaySavedDesign({
      savedDesignUrl: "https://evil.example/design?tid=design_12345",
      allowedHosts: ["customhouse.se"],
    }),
  );
  assert.throws(() =>
    parseInkyBaySavedDesign({
      savedDesignUrl: "https://customhouse.se/design?tid=design_12345",
      tid: "different_12345",
      allowedHosts: ["customhouse.se"],
    }),
  );
});

test("compatible variants are restricted to the verified product variants", () => {
  assert.deepEqual(
    parseCompatibleVariantIds(
      ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/999"],
      ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"],
    ),
    ["gid://shopify/ProductVariant/1"],
  );
  assert.throws(() =>
    parseCompatibleVariantIds(
      ["gid://shopify/ProductVariant/999"],
      ["gid://shopify/ProductVariant/1"],
    ),
  );
});

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("production artwork accepts high resolution PNG and valid PDF only", () => {
  assert.equal(
    validateProductionArtwork(png(3000, 3000), "art.png", "image/png", {
      maximumBytes: 10_000,
      minimumWidth: 2000,
      minimumHeight: 2000,
    }).mimeType,
    "image/png",
  );
  const pdf = new TextEncoder().encode("%PDF-1.7\ncreator artwork\n%%EOF");
  assert.equal(
    validateProductionArtwork(pdf, "art.pdf", "application/pdf", {
      maximumBytes: 10_000,
      minimumWidth: 2000,
      minimumHeight: 2000,
    }).mimeType,
    "application/pdf",
  );
  assert.throws(() =>
    validateProductionArtwork(png(500, 500), "small.png", "image/png", {
      maximumBytes: 10_000,
      minimumWidth: 2000,
      minimumHeight: 2000,
    }),
  );
  assert.throws(() =>
    validateProductionArtwork(
      new TextEncoder().encode("<svg><script>alert(1)</script></svg>"),
      "art.svg",
      "image/svg+xml",
      { maximumBytes: 10_000, minimumWidth: 2000, minimumHeight: 2000 },
    ),
  );
});

test("creator session token is signed, scoped and expiring", () => {
  const token = signInkyBaySessionToken(
    {
      sessionId: "session-a",
      shop: "custom-house.myshopify.com",
      customerId: "gid://shopify/Customer/1",
      creatorId: "creator-a",
    },
    60,
  );
  assert.equal(verifyInkyBaySessionToken(token).sessionId, "session-a");
  assert.throws(() => verifyInkyBaySessionToken(`${token}tampered`));
  assert.throws(() =>
    verifyInkyBaySessionToken(
      signInkyBaySessionToken(
        {
          sessionId: "session-a",
          shop: "custom-house.myshopify.com",
          customerId: "gid://shopify/Customer/1",
          creatorId: "creator-a",
        },
        -1,
      ),
    ),
  );
});

test("workspace requires private production artwork and documents manual bridge", () => {
  const html = inkyBayWorkspaceHtml({
    sessionToken: "safe-token",
    data: {
      id: "session-a",
      status: "WAITING_FOR_ASSETS",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      savedDesignUrl: null,
      tid: null,
      title: null,
      description: null,
      previewUrl: null,
      productionArtworkReady: false,
      compatibleVariantIds: [],
      product: {
        title: "Global T-shirt",
        imageUrl: null,
        selectedVariantId: "gid://shopify/ProductVariant/1",
        inkyBayProductUrl: "/products/global-shirt",
        variants: [
          {
            id: "gid://shopify/ProductVariant/1",
            title: "Small / Black",
            availableForSale: true,
          },
        ],
      },
      creator: { displayName: "Ari", collectionUrl: null },
    },
  });
  assert.match(html, /name="productionArtwork"/);
  assert.match(
    html,
    /manual bridge does not claim an unsupported InkyBay API/i,
  );
  assert.match(html, /Publish to My Collection/);
  assert.match(html, /X-Customhouse-Session-Token/);
});

test("theme creator action remains hidden until trusted eligibility resolves", async () => {
  const liquid = await readFile(
    "extensions/customhouse-creator-storefront/blocks/inkybay-creator-actions.liquid",
    "utf8",
  );
  const script = await readFile(
    "extensions/customhouse-creator-storefront/assets/customhouse-inkybay-creator.js",
    "utf8",
  );
  assert.match(liquid, /data-inkybay-create hidden disabled/);
  assert.match(liquid, /product_type == 'global_customizable'/);
  assert.match(liquid, /data-app-proxy-root/);
  assert.match(liquid, /default: '\/apps\/customhouse'/);
  assert.doesNotMatch(liquid, /creator_fixed/);
  assert.match(script, /eligibility\.creatorPublishAvailable/);
  assert.match(script, /idempotencyKey/);
  assert.match(script, /configuredProxyRoot/);
  assert.doesNotMatch(script, /localStorage/);
});

test("fixed product publishing never exposes private artwork in Shopify metafields", async () => {
  const source = await readFile(
    "app/services/designer-publishing.server.ts",
    "utf8",
  );
  const metafieldSection = source.slice(
    source.indexOf("const metafields ="),
    source.indexOf("const metafieldResult ="),
  );
  assert.match(metafieldSection, /inkybay_saved_design_tid/);
  assert.doesNotMatch(metafieldSection, /productionArtworkKey|artworkUrl/);
  assert.match(source, /status: "DRAFT"/);
  assert.ok(
    source.lastIndexOf('setProductStatus(client, input.productId, "ACTIVE")') >
      source.indexOf("Designer collection membership"),
  );
});

test("creator fixed order snapshots are immutable and retain private artwork mapping", async () => {
  const source = await readFile(
    "app/services/order-design-snapshot.server.ts",
    "utf8",
  );
  assert.match(source, /productionArtworkKey: design\.productionArtworkKey/);
  assert.match(source, /skipDuplicates: true/);
  assert.doesNotMatch(source, /updateMany|upsert/);
});
