import assert from "node:assert/strict";
import test from "node:test";
import {
  canHandleMutatingWebhook,
  canProcessPreviewOrder,
  canRunPreviewMutation,
  canRunProductionCreatorPublishing,
  databaseIsolationStatus,
  isPreviewOwnedRecord,
  previewOrderCandidate,
  runCustomerMutation,
  safetyDiagnostics,
  type SafetyEnvironment,
} from "../app/services/environment-safety.server.ts";

const preview: SafetyEnvironment = {
  APP_ENV: "preview",
  SHOPIFY_API_KEY: "public-client-id-ending-800679",
  PREVIEW_SHOP_DOMAIN: "custom-house-5750.myshopify.com",
  PREVIEW_MUTATIONS_ENABLED: "true",
  PREVIEW_ORDER_TESTING_ENABLED: "false",
  PREVIEW_TEST_PRODUCT_IDS: "gid://shopify/Product/123",
  PREVIEW_TEST_COLLECTION_IDS: "gid://shopify/Collection/456",
};

test("Preview database isolation requires distinct branch and endpoint identities", () => {
  const isolated = {
    ...preview,
    DATABASE_URL: "postgresql://redacted@ep-preview-pooler.example/db",
    DIRECT_DATABASE_URL: "postgresql://redacted@ep-preview.example/db",
    PREVIEW_DATABASE_BRANCH_ID: "br-preview",
    PRODUCTION_DATABASE_BRANCH_ID: "br-production",
    PREVIEW_DATABASE_ENDPOINT_ID: "ep-preview",
    PRODUCTION_DATABASE_ENDPOINT_ID: "ep-production",
  };
  assert.equal(databaseIsolationStatus(isolated), "verified");
  assert.equal(
    databaseIsolationStatus({
      ...isolated,
      PRODUCTION_DATABASE_BRANCH_ID: "br-preview",
    }),
    "unverified",
  );
  assert.equal(
    databaseIsolationStatus({
      ...isolated,
      PRODUCTION_DATABASE_ENDPOINT_ID: "ep-preview",
    }),
    "unverified",
  );
});

test("Preview mutations default deny missing environment, allowlist, shop, client, or flag", () => {
  const context = {
    shop: "custom-house-5750.myshopify.com",
    resourceType: "product" as const,
    resourceId: "gid://shopify/Product/123",
  };
  assert.equal(canRunPreviewMutation(context, { ...preview, APP_ENV: undefined }), false);
  assert.equal(canRunPreviewMutation(context, { ...preview, PREVIEW_TEST_PRODUCT_IDS: "" }), false);
  assert.equal(canRunPreviewMutation({ ...context, shop: "wrong.myshopify.com" }, preview), false);
  assert.equal(canRunPreviewMutation(context, { ...preview, SHOPIFY_API_KEY: "wrong" }), false);
  assert.equal(canRunPreviewMutation(context, { ...preview, PREVIEW_MUTATIONS_ENABLED: "false" }), false);
  assert.equal(canRunPreviewMutation(context, preview), true);
});

test("Existing production products are denied while Preview-owned records are recognized", () => {
  assert.equal(
    canRunPreviewMutation(
      {
        shop: "custom-house-5750.myshopify.com",
        resourceType: "product",
        resourceId: "gid://shopify/Product/999",
      },
      preview,
    ),
    false,
  );
  const owned = isPreviewOwnedRecord(
    { previewPoc: true, previewOwnerApp: "customhouse-dev-800679" },
    preview,
  );
  assert.equal(owned, true);
  assert.equal(
    canRunPreviewMutation(
      {
        shop: "custom-house-5750.myshopify.com",
        resourceType: "product",
        resourceId: "gid://shopify/Product/999",
        previewOwned: owned,
      },
      preview,
    ),
    true,
  );
});

test("Preview product webhook guard prevents a DRAFT GraphQL mutation", async () => {
  let graphqlCalls = 0;
  const deniedEnvironment = {
    ...preview,
    PREVIEW_MUTATIONS_ENABLED: "false",
  };
  if (
    canHandleMutatingWebhook(
      {
        shop: "custom-house-5750.myshopify.com",
        resourceType: "product",
        resourceId: "gid://shopify/Product/123",
      },
      deniedEnvironment,
    )
  ) {
    graphqlCalls += 1;
  }
  assert.equal(graphqlCalls, 0);
});

test("Helium customer mutation guard skips tagsAdd in Preview", async () => {
  let graphqlCalls = 0;
  const result = await runCustomerMutation(
    async () => {
      graphqlCalls += 1;
      return { tagsAdd: { userErrors: [] } };
    },
    preview,
  );
  assert.deepEqual(result, {
    skipped: true,
    reason: "PREVIEW_CUSTOMER_MUTATION_DISABLED",
  });
  assert.equal(graphqlCalls, 0);
});

test("Ordinary orders are ignored and Preview candidates still require the order flag", () => {
  assert.deepEqual(previewOrderCandidate({ line_items: [{ product_id: 123 }] }), {
    productIds: [],
    hasPreviewReference: false,
  });
  const candidate = previewOrderCandidate({
    line_items: [
      {
        product_id: 123,
        properties: [
          { name: "_custom_house_preview_poc", value: "true" },
          { name: "_custom_house_purchase_token", value: "signed-reference" },
        ],
      },
    ],
  });
  assert.equal(
    canProcessPreviewOrder(
      {
        shop: "custom-house-5750.myshopify.com",
        productIds: candidate.productIds,
        hasVerifiedPreviewReference: candidate.hasPreviewReference,
      },
      preview,
    ),
    false,
  );
  assert.equal(
    canProcessPreviewOrder(
      {
        shop: "custom-house-5750.myshopify.com",
        productIds: candidate.productIds,
        hasVerifiedPreviewReference: true,
      },
      { ...preview, PREVIEW_ORDER_TESTING_ENABLED: "true" },
    ),
    true,
  );
});

test("Production creator publishing requires explicit rollout approval", () => {
  const production = {
    APP_ENV: "production",
    INKYBAY_CREATOR_PUBLISHING_ENABLED: "true",
  };
  assert.equal(canRunProductionCreatorPublishing(production), false);
  assert.equal(
    canRunProductionCreatorPublishing({
      ...production,
      PRODUCTION_ROLLOUT_APPROVED: "true",
    }),
    true,
  );
});

test("Safety diagnostics expose booleans and no environment values", () => {
  assert.deepEqual(safetyDiagnostics({ ...preview, PREVIEW_MUTATIONS_ENABLED: "false" }), {
    environment: "preview",
    databaseIsolation: "unverified",
    creatorPublishingEnabled: false,
    manualBridgeEnabled: false,
    customCallbackEnabled: false,
    previewMutationsEnabled: false,
    previewOrderTestingEnabled: false,
    productionRolloutApproved: false,
  });
});
