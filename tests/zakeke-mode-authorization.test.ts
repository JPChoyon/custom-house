import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeStorefrontActor,
  type StorefrontCreatorStatus,
} from "../app/services/storefront-actor.ts";
import { designerPublishKey } from "../app/services/designer-publishing.ts";
import { zakekeDesignerHtml } from "../app/services/zakeke/zakeke-designer-page.server.ts";
import {
  authorizeZakekeMode,
  parseZakekeDesignerIntent,
  zakekeCallbackDestination,
  zakekeCartButtonText,
} from "../app/services/zakeke/zakeke-mode.ts";
import {
  signZakekeDesignerSession,
  verifyZakekeDesignerSession,
} from "../app/services/zakeke/zakeke-signing.server.ts";

process.env.ZAKEKE_TOKEN_ENCRYPTION_SECRET = "s".repeat(48);

function actor(
  status: StorefrontCreatorStatus | null,
  suspendedAt: Date | null = null,
) {
  return normalizeStorefrontActor({
    customerId: "gid://shopify/Customer/10",
    creator: status
      ? { id: "creator-10", status, suspendedAt }
      : null,
  });
}

test("actual approved status is APPROVED and not approve", async () => {
  const schema = await readFile(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  assert.match(schema, /enum CreatorStatus\s*\{[^}]*APPROVED/s);
  assert.doesNotMatch(schema, /^\s*approve\s*$/m);
  assert.equal(actor("APPROVED").isApprovedCreator, true);
  assert.equal(
    normalizeStorefrontActor({
      customerId: "gid://shopify/Customer/10",
      creator: {
        id: "creator-10",
        status: "approve" as StorefrontCreatorStatus,
        suspendedAt: null,
      },
    }).isApprovedCreator,
    false,
  );
});

test("storefront actor maps approved creator and Shopify customer identity", () => {
  const approved = actor("APPROVED");
  assert.equal(approved.customerId, "gid://shopify/Customer/10");
  assert.equal(approved.creatorId, "creator-10");
  assert.equal(approved.role, "CREATOR");
  assert.deepEqual(approved.authorizedDesignerModes, [
    "CUSTOMER_BUY",
    "CREATOR_BUY",
    "CREATOR_PUBLISH",
  ]);
});

test("pending, rejected, and suspended creators cannot use creator modes", () => {
  for (const status of [
    "PENDING",
    "REJECTED",
    "SUSPENDED",
  ] as const) {
    const value = actor(status);
    assert.deepEqual(value.authorizedDesignerModes, ["CUSTOMER_BUY"]);
    assert.throws(
      () => authorizeZakekeMode(value, "CREATOR_PUBLISH"),
      /approved, active creators/i,
    );
  }
  const suspendedTimestamp = actor("APPROVED", new Date());
  assert.equal(suspendedTimestamp.isSuspended, true);
  assert.deepEqual(suspendedTimestamp.authorizedDesignerModes, [
    "CUSTOMER_BUY",
  ]);
});

test("normal customer and guest receive customer-buy mode only", () => {
  const customer = actor(null);
  const guest = normalizeStorefrontActor({
    customerId: null,
    creator: null,
  });
  assert.equal(customer.role, "CUSTOMER");
  assert.equal(guest.role, "GUEST");
  assert.deepEqual(customer.authorizedDesignerModes, ["CUSTOMER_BUY"]);
  assert.deepEqual(guest.authorizedDesignerModes, ["CUSTOMER_BUY"]);
  assert.equal(
    authorizeZakekeMode(customer, "CUSTOMER_BUY"),
    "CUSTOMER_BUY",
  );
});

test("only explicit designer intents are accepted", () => {
  assert.equal(
    parseZakekeDesignerIntent("customer_buy"),
    "CUSTOMER_BUY",
  );
  assert.equal(
    parseZakekeDesignerIntent("creator_buy"),
    "CREATOR_BUY",
  );
  assert.equal(
    parseZakekeDesignerIntent("creator_publish"),
    "CREATOR_PUBLISH",
  );
  assert.throws(() => parseZakekeDesignerIntent("creator"), /invalid/i);
  assert.throws(() => parseZakekeDesignerIntent("approve"), /invalid/i);
});

test("Customizer UI button and callback destination are mode-bound", () => {
  assert.equal(zakekeCartButtonText("CUSTOMER_BUY"), "Add to Cart");
  assert.equal(zakekeCartButtonText("CREATOR_BUY"), "Add to Cart");
  assert.equal(
    zakekeCartButtonText("CREATOR_PUBLISH"),
    "Add to My Collection",
  );
  assert.equal(zakekeCallbackDestination("CUSTOMER_BUY"), "cart");
  assert.equal(zakekeCallbackDestination("CREATOR_BUY"), "cart");
  assert.equal(zakekeCallbackDestination("CREATOR_PUBLISH"), "publish");
});

test("signed sessions preserve creator-buy and creator-publish modes", () => {
  for (const mode of ["CREATOR_BUY", "CREATOR_PUBLISH"] as const) {
    const token = signZakekeDesignerSession({
      sessionId: `session-${mode}`,
      shop: "test.myshopify.com",
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/2",
      mode,
      principal: "gid://shopify/Customer/10",
      creatorId: "creator-10",
      nonce: "nonce-123456789",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    assert.equal(verifyZakekeDesignerSession(token).mode, mode);
  }
});

test("creator publish HTML configures the iframe action itself", () => {
  const html = zakekeDesignerHtml({
    customizerScriptUrl:
      "https://portal.zakeke.com/scripts/integration/apiV2/customizer.js",
    sessionToken: "signed-session",
    tokenOauth: "c2s-token",
    mode: "CREATOR_PUBLISH",
    product: {
      id: "TEE",
      title: "Test T-shirt",
      price: 20,
      attributes: { size: "S", color: "black" },
    },
  });
  assert.match(html, /cartButtonText:\s*"Add to My Collection"/);
  assert.match(html, /addToCart:\s*\(data\) => complete\(data\)/);
  assert.match(html, /productId:\s*payload\.productId/);
  assert.doesNotMatch(html, /MutationObserver|contentWindow|contentDocument/);
});

test("duplicate creator publish keys remain stable per signed session", () => {
  const first = designerPublishKey(
    "test.myshopify.com",
    "creator-10",
    "session-10",
  );
  const duplicate = designerPublishKey(
    "test.myshopify.com",
    "creator-10",
    "session-10",
  );
  assert.equal(first, duplicate);
});

test("fixed creator products exit before any designer launch", async () => {
  const source = await readFile(
    new URL(
      "../extensions/customhouse-creator-storefront/assets/customhouse-zakeke.js",
      import.meta.url,
    ),
    "utf8",
  );
  const fixedBranch = source.indexOf(
    'if (data.productType === "creator_fixed")',
  );
  const fixedReturn = source.indexOf("return;", fixedBranch);
  const globalActions = source.indexOf(
    'root.querySelector("[data-zakeke-global-actions]")',
  );
  assert.ok(fixedBranch >= 0);
  assert.ok(fixedReturn > fixedBranch);
  assert.ok(globalActions > fixedReturn);
});
