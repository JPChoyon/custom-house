import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createCanvas, loadImage } from "canvas";
import { DomainError } from "../app/services/domain.ts";
import {
  canCreatorPublish,
  designerPublishKey,
  duplicateVariantsToDelete,
  fixedProductTags,
  ownsDesignSession,
} from "../app/services/designer-publishing.ts";
import {
  signDesignCartToken,
  verifyDesignCartToken,
} from "../app/services/designer-token.server.ts";
import {
  inspectImage,
  validateDesignAssetUrls,
  validateDesignJson,
  validateImageUpload,
} from "../app/services/designer-validation.ts";
import { renderDesignerArtifacts } from "../app/services/designer-render.server.ts";

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("normal and pending customers cannot publish creator designs", () => {
  assert.equal(canCreatorPublish(null, null), false);
  assert.equal(canCreatorPublish("PENDING", null), false);
});

test("suspended creators cannot publish", () => {
  assert.equal(canCreatorPublish("SUSPENDED", new Date()), false);
  assert.equal(canCreatorPublish("APPROVED", new Date()), false);
});

test("approved active creators can publish", () => {
  assert.equal(canCreatorPublish("APPROVED", null), true);
});

test("creator cannot publish another creator's design session", () => {
  const session = {
    shop: "store.myshopify.com",
    customerId: "gid://shopify/Customer/1",
    creatorId: "creator-a",
  };
  assert.equal(
    ownsDesignSession(session, {
      shop: session.shop,
      customerId: session.customerId,
      creatorId: "creator-b",
    }),
    false,
  );
  assert.equal(
    ownsDesignSession(session, {
      shop: session.shop,
      customerId: session.customerId,
      creatorId: session.creatorId,
    }),
    true,
  );
});

test("invalid and mismatched uploads are rejected", () => {
  assert.throws(() => inspectImage(new Uint8Array([1, 2, 3])), DomainError);
  assert.throws(
    () =>
      validateImageUpload(png(1200, 1200), "image.jpg", "image/jpeg", {
        maximumBytes: 1024,
        minimumWidth: 600,
        minimumHeight: 600,
        allowedTypes: ["image/png", "image/jpeg"],
      }),
    /does not match/,
  );
});

test("valid image dimensions are read from file bytes", () => {
  const bytes = png(1600, 1800);
  assert.deepEqual(inspectImage(bytes), {
    mimeType: "image/png",
    width: 1600,
    height: 1800,
  });
  assert.equal(
    validateImageUpload(bytes, "art.png", "image/png", {
      maximumBytes: 1024,
      minimumWidth: 600,
      minimumHeight: 600,
      allowedTypes: ["image/png"],
    }).width,
    1600,
  );
});

test("design JSON validates and reloads without mutation", () => {
  const serialized = JSON.stringify({
    version: "7.4.0",
    objects: [{ type: "Textbox", text: "Custom House", left: 10, top: 20 }],
  });
  assert.deepEqual(validateDesignJson(serialized), JSON.parse(serialized));
});

test("large embedded base64 artwork is rejected from design JSON", () => {
  assert.throws(
    () =>
      validateDesignJson(
        JSON.stringify({
          objects: [{ type: "Image", src: "data:image/png;base64,abc" }],
        }),
      ),
    /Embedded files/,
  );
});

test("design image URLs are restricted to Shopify Files", () => {
  assert.throws(
    () =>
      validateDesignAssetUrls(
        {
          objects: [
            { type: "FabricImage", src: "https://internal.example.test/file.png" },
          ],
        },
        ["cdn.shopify.com"],
      ),
    /unsupported source/,
  );
  assert.deepEqual(
    validateDesignAssetUrls(
      {
        objects: [
          {
            type: "FabricImage",
            src: "https://cdn.shopify.com/s/files/test.png",
          },
        ],
      },
      ["cdn.shopify.com"],
    ),
    ["https://cdn.shopify.com/s/files/test.png"],
  );
});

test("duplicate publish key is stable and scoped to creator session", () => {
  const key = designerPublishKey("shop", "creator-a", "session-a");
  assert.equal(key, designerPublishKey("shop", "creator-a", "session-a"));
  assert.notEqual(key, designerPublishKey("shop", "creator-b", "session-a"));
  assert.notEqual(key, designerPublishKey("shop", "creator-a", "session-b"));
});

test("fixed products receive locked creator tags and never creator-base", () => {
  const tags = fixedProductTags(["global", "creator-base"]);
  assert.deepEqual(tags, [
    "global",
    "creator-fixed",
    "custom-house-creator-product",
  ]);
});

test("only allowlisted size and color combinations survive duplication", () => {
  const source = [
    {
      id: "source-small",
      selectedOptions: [
        { name: "Color", value: "Black" },
        { name: "Size", value: "S" },
      ],
    },
    {
      id: "source-large",
      selectedOptions: [
        { name: "Color", value: "Black" },
        { name: "Size", value: "L" },
      ],
    },
  ];
  const duplicate = [
    { ...source[0], id: "duplicate-small" },
    { ...source[1], id: "duplicate-large" },
  ];
  assert.deepEqual(
    duplicateVariantsToDelete(source, ["source-small"], duplicate),
    ["duplicate-large"],
  );
});

test("customer finalize cart token is signed and bound to design version", () => {
  const previous = process.env.DESIGN_SIGNING_SECRET;
  process.env.DESIGN_SIGNING_SECRET = "test-secret-with-at-least-thirty-two-characters";
  try {
    const token = signDesignCartToken({
      designId: "design-1",
      version: 3,
      shop: "shop.myshopify.com",
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/2",
    });
    const payload = verifyDesignCartToken(token);
    assert.equal(payload.designId, "design-1");
    assert.equal(payload.version, 3);
    assert.throws(() => verifyDesignCartToken(`${token}tampered`));
  } finally {
    if (previous === undefined) delete process.env.DESIGN_SIGNING_SECRET;
    else process.env.DESIGN_SIGNING_SECRET = previous;
  }
});

test("expired customer cart token is rejected", () => {
  const previous = process.env.DESIGN_SIGNING_SECRET;
  process.env.DESIGN_SIGNING_SECRET = "test-secret-with-at-least-thirty-two-characters";
  try {
    const token = signDesignCartToken(
      {
        designId: "design-1",
        version: 1,
        shop: "shop.myshopify.com",
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/2",
      },
      -1,
    );
    assert.throws(() => verifyDesignCartToken(token), /expired/);
  } finally {
    if (previous === undefined) delete process.env.DESIGN_SIGNING_SECRET;
    else process.env.DESIGN_SIGNING_SECRET = previous;
  }
});

const editorSource = readFileSync(
  path.join(
    process.cwd(),
    "extensions/customhouse-creator-storefront/assets/customhouse-designer.js",
  ),
  "utf8",
);

test("mockup is excluded from transparent artwork export", () => {
  const cropIndex = editorSource.indexOf("const artworkCrop = canvas.toCanvasElement");
  const mockupIndex = editorSource.indexOf("const mockup = await loadHtmlImage");
  assert.ok(cropIndex > -1);
  assert.ok(mockupIndex > cropIndex);
  assert.match(editorSource, /artworkContext\.drawImage\(\s*artworkCrop/);
});

test("backend Fabric renderer keeps mockup out of transparent artwork", async () => {
  const mockup = createCanvas(100, 120);
  const mockupContext = mockup.getContext("2d");
  mockupContext.fillStyle = "#ff0000";
  mockupContext.fillRect(0, 0, 100, 120);
  const result = await renderDesignerArtifacts(
    JSON.stringify({ version: "7.4.0", objects: [] }),
    {
      shopifyProductId: "gid://shopify/Product/1",
      mockupImageUrl: mockup.toDataURL("image/png"),
      canvasWidth: 100,
      canvasHeight: 120,
      printArea: { x: 20, y: 30, width: 40, height: 50 },
      exportWidth: 80,
      exportHeight: 100,
      minimumUploadWidth: 10,
      minimumUploadHeight: 10,
      maximumUploadBytes: 1024,
      allowedFileTypes: ["image/png"],
      allowedVariantIds: [],
    },
  );
  assert.deepEqual(inspectImage(result.artwork), {
    mimeType: "image/png",
    width: 80,
    height: 100,
  });
  const artworkImage = await loadImage(Buffer.from(result.artwork));
  const artworkCanvas = createCanvas(80, 100);
  artworkCanvas.getContext("2d").drawImage(artworkImage, 0, 0);
  assert.equal(artworkCanvas.getContext("2d").getImageData(0, 0, 1, 1).data[3], 0);
  const previewImage = await loadImage(Buffer.from(result.preview));
  const previewCanvas = createCanvas(100, 120);
  previewCanvas.getContext("2d").drawImage(previewImage, 0, 0);
  assert.equal(previewCanvas.getContext("2d").getImageData(0, 0, 1, 1).data[0], 255);
});

test("Fabric is dynamically imported only after config and open action", () => {
  assert.match(editorSource, /await import\(root\.dataset\.fabricModule\)/);
  assert.ok(
    editorSource.indexOf("await api(`designer/config?${query}`)") <
      editorSource.indexOf("await initializeEditor(root, bootstrap)"),
  );
});

test("editor bootstrap boundary keeps errors visible instead of blanking", () => {
  assert.match(editorSource, /data-designer-bootstrap-error/);
  assert.match(editorSource, /The editor could not be opened/);
});

test("publish failure keeps product ID and a retryable failed state", () => {
  const publishingSource = readFileSync(
    path.join(
      process.cwd(),
      "app/services/designer-publishing.server.ts",
    ),
    "utf8",
  );
  assert.match(publishingSource, /shopifyCreatorProductId: productId/);
  assert.match(publishingSource, /syncStatus: "FAILED"/);
  assert.match(publishingSource, /currentProductId: productId/);
});

test("suspension hides only active synchronized Fabric products", () => {
  const publishingSource = readFileSync(
    path.join(
      process.cwd(),
      "app/services/designer-publishing.server.ts",
    ),
    "utf8",
  );
  assert.match(publishingSource, /status: "SUSPENDED", syncStatus: "HIDDEN"/);
  assert.match(publishingSource, /status: "ACTIVE", syncStatus: "SYNCED"/);
  assert.match(publishingSource, /setProductStatus\(client, design\.shopifyCreatorProductId, "DRAFT"\)/);
});
