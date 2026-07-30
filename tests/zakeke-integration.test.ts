import assert from "node:assert/strict";
import test from "node:test";
import { ZakekeAuthService } from "../app/services/zakeke/zakeke-auth.server.ts";
import { ZakekeClient } from "../app/services/zakeke/zakeke-client.server.ts";
import { ZakekeDesignService } from "../app/services/zakeke/zakeke-designs.server.ts";
import { ZakekeOrderService } from "../app/services/zakeke/zakeke-orders.server.ts";
import { ZakekeError } from "../app/services/zakeke/zakeke-errors.server.ts";
import {
  getZakekeFeatureFlags,
  zakekeConnectionSummary,
} from "../app/services/zakeke/zakeke-config.server.ts";
import { parseVariantMapping } from "../app/services/zakeke/zakeke-mapping.ts";
import {
  hashOpaqueValue,
  signDesignPurchaseToken,
  signZakekeDesignerSession,
  verifyDesignPurchaseToken,
  verifyZakekeDesignerSession,
} from "../app/services/zakeke/zakeke-signing.server.ts";
import { zakekeIdentityForPrincipal } from "../app/services/zakeke/zakeke-identity.ts";

process.env.ZAKEKE_CLIENT_ID = "test-client";
process.env.ZAKEKE_CLIENT_SECRET = "test-secret";
process.env.ZAKEKE_API_BASE_URL = "https://zakeke.test";
process.env.ZAKEKE_TOKEN_ENCRYPTION_SECRET = "s".repeat(48);
process.env.DESIGN_PURCHASE_SIGNING_SECRET = "p".repeat(48);

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Zakeke production features remain disabled unless explicitly enabled", () => {
  delete process.env.ZAKEKE_INTEGRATION_ENABLED;
  delete process.env.ZAKEKE_CREATOR_PUBLISHING_ENABLED;
  delete process.env.ZAKEKE_FIXED_PURCHASE_ENABLED;
  assert.deepEqual(getZakekeFeatureFlags(), {
    integration: false,
    creatorPublishing: false,
    fixedPurchase: false,
  });
  assert.equal(zakekeConnectionSummary().credentialsConfigured, true);
});

test("variant mapping rejects duplicates and preserves explicit compatibility", () => {
  const valid = parseVariantMapping(
    JSON.stringify({
      variants: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/1",
          sku: "TEE-S-BLACK",
          attributes: { size: "S", color: "black" },
          enabled: true,
        },
      ],
    }),
  );
  assert.equal(valid.variants[0].attributes.color, "black");
  assert.throws(
    () =>
      parseVariantMapping(
        JSON.stringify({
          variants: [
            {
              shopifyVariantId: "gid://shopify/ProductVariant/1",
              sku: "ONE",
              attributes: { size: "S" },
            },
            {
              shopifyVariantId: "gid://shopify/ProductVariant/1",
              sku: "TWO",
              attributes: { size: "M" },
            },
          ],
        }),
      ),
    /invalid or duplicate/i,
  );
});

test("C2S and S2S tokens use Basic auth and identity-scoped form data", async () => {
  const requests: Array<{ authorization: string; body: string }> = [];
  let issued = 0;
  const auth = new ZakekeAuthService(async (_url, options) => {
    issued += 1;
    requests.push({
      authorization: String(
        new Headers(options?.headers).get("Authorization"),
      ),
      body: String(options?.body),
    });
    return jsonResponse({
      access_token: `token-${issued}`,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const c2s = await auth.getC2SToken({
    customerCode: "shopify-c2s-test",
  });
  const s2s = await auth.getS2SToken({
    visitorCode: "visitor-s2s-test",
  });
  assert.equal(c2s.accessType, "C2S");
  assert.equal(s2s.accessType, "S2S");
  assert.match(requests[0].authorization, /^Basic /);
  assert.match(requests[0].body, /access_type=C2S/);
  assert.match(requests[0].body, /customercode=shopify-c2s-test/);
  assert.match(requests[1].body, /access_type=S2S/);
  assert.match(requests[1].body, /visitorcode=visitor-s2s-test/);
  assert.doesNotMatch(requests[0].body, /test-secret/);
});

test("Zakeke client refreshes once after 401 and retries safe rate limits", async () => {
  let tokenCalls = 0;
  const auth = new ZakekeAuthService(async () => {
    tokenCalls += 1;
    return jsonResponse({
      "access-token": `token-${tokenCalls}`,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  let apiCalls = 0;
  const waits: number[] = [];
  const client = new ZakekeClient(
    auth,
    async () => {
      apiCalls += 1;
      if (apiCalls === 1) return jsonResponse({}, 401);
      if (apiCalls === 2) return jsonResponse({}, 429);
      return jsonResponse({ designID: "design-1", modelCode: "TEE" });
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
  );
  const design = await client.requestJson<{
    designID: string;
    modelCode: string;
  }>("/v3/designs/design-1/1", {
    operation: "design_get",
    retryable: true,
  });
  assert.equal(design.designID, "design-1");
  assert.equal(tokenCalls, 2);
  assert.equal(apiCalls, 3);
  assert.deepEqual(waits, [200]);
});

test("documented design and order endpoints are used", async () => {
  const paths: Array<{ url: string; method: string }> = [];
  const auth = new ZakekeAuthService(async () =>
    jsonResponse({
      access_token: "service-token",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  );
  const client = new ZakekeClient(auth, async (url, options) => {
    const value = String(url);
    paths.push({ url: value, method: String(options?.method || "GET") });
    if (value.endsWith("/v2/designs/design-1")) {
      return jsonResponse({ id: "design-copy" });
    }
    if (value.endsWith("/v1/designs/design-1/items")) {
      return jsonResponse({ variant: { code: "TEE" } });
    }
    if (value.endsWith("/v1/designs/design-1/outputfiles/zip")) {
      return jsonResponse({ url: "https://files.zakeke.test/design.zip" });
    }
    if (value.endsWith("/v2/order")) {
      return jsonResponse({ accepted: true });
    }
    return jsonResponse({
      designID: "design-1",
      modelCode: "TEE",
      previewimageurl: "https://files.zakeke.test/preview.png",
    });
  });
  const designs = new ZakekeDesignService(client);
  const orders = new ZakekeOrderService(client);
  await designs.getDesign("design-1");
  await designs.duplicateDesign("design-1");
  await designs.getDesignItems("design-1");
  await designs.getOutputFiles("design-1");
  await orders.registerOrder({
    orderCode: "#1001",
    orderDate: new Date(0).toISOString(),
    sessionID: "order-1",
    total: 20,
    details: [
      {
        orderDetailCode: "line-1",
        sku: "TEE-S",
        designID: "design-1",
        modelUnitPrice: 20,
        designUnitPrice: 0,
        quantity: 1,
      },
    ],
  });
  assert.deepEqual(
    paths.map((entry) => [
      new URL(entry.url).pathname,
      entry.method,
    ]),
    [
      ["/v3/designs/design-1/1", "GET"],
      ["/v2/designs/design-1", "POST"],
      ["/v1/designs/design-1/items", "GET"],
      ["/v1/designs/design-1/outputfiles/zip", "GET"],
      ["/v2/order", "POST"],
    ],
  );
});

test("invalid design identifiers are rejected before an API request", async () => {
  let apiCalls = 0;
  const client = new ZakekeClient(
    new ZakekeAuthService(async () =>
      jsonResponse({
        access_token: "service-token",
        expires_in: 3600,
      }),
    ),
    async () => {
      apiCalls += 1;
      return jsonResponse({});
    },
  );
  const designs = new ZakekeDesignService(client);

  assert.throws(() => designs.getDesign("../unsafe"), /invalid/i);
  assert.equal(apiCalls, 0);
});

test("API timeouts and provider errors are sanitized", async () => {
  const auth = new ZakekeAuthService(async () =>
    jsonResponse({
      access_token: "service-token",
      expires_in: 3600,
    }),
  );
  const timeoutClient = new ZakekeClient(
    auth,
    async (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    async () => undefined,
    5,
  );

  await assert.rejects(
    () =>
      timeoutClient.requestJson("/v3/designs/design-1/1", {
        operation: "design_get",
        retryable: true,
      }),
    (error: unknown) =>
      error instanceof ZakekeError &&
      error.code === "ZAKEKE_UNAVAILABLE" &&
      !error.message.includes("AbortError"),
  );

  const providerClient = new ZakekeClient(
    auth,
    async () =>
      new Response(
        JSON.stringify({
          access_token: "must-never-leak",
          detail: "raw provider failure",
        }),
        { status: 500 },
      ),
    async () => undefined,
  );
  await assert.rejects(
    () =>
      providerClient.requestJson("/v3/designs/design-1/1", {
        operation: "design_get",
        retryable: false,
      }),
    (error: unknown) =>
      error instanceof ZakekeError &&
      !error.message.includes("must-never-leak") &&
      !error.message.includes("raw provider failure"),
  );
});

test("independent Zakeke duplications return independent design IDs", async () => {
  let sequence = 0;
  const client = new ZakekeClient(
    new ZakekeAuthService(async () =>
      jsonResponse({
        access_token: "service-token",
        expires_in: 3600,
      }),
    ),
    async () => {
      sequence += 1;
      return jsonResponse({ id: `design-copy-${sequence}` });
    },
  );
  const designs = new ZakekeDesignService(client);
  const first = await designs.duplicateDesign("design-source");
  const second = await designs.duplicateDesign("design-source");

  assert.notEqual(first.id, second.id);
  assert.equal(sequence, 2);
});

test("designer and purchase tokens are signed, scoped, and expiring", () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const sessionToken = signZakekeDesignerSession({
    sessionId: "session-1",
    shop: "test.myshopify.com",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/2",
    mode: "CREATOR_PUBLISH",
    principal: "gid://shopify/Customer/3",
    creatorId: "creator-1",
    nonce: "nonce-123456789",
    expiresAt,
  });
  assert.equal(
    verifyZakekeDesignerSession(sessionToken).creatorId,
    "creator-1",
  );
  assert.throws(
    () => verifyZakekeDesignerSession(`${sessionToken}tampered`),
    /invalid/i,
  );

  const purchaseToken = signDesignPurchaseToken({
    purchaseId: "purchase-1",
    shop: "test.myshopify.com",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/2",
    principal: "visitor:abcdefghijklmnopqrstuvwxyz",
    expiresAt,
  });
  assert.equal(
    verifyDesignPurchaseToken(purchaseToken).purchaseId,
    "purchase-1",
  );
  assert.throws(
    () => verifyDesignPurchaseToken(`${purchaseToken}tampered`),
    /invalid/i,
  );
  assert.equal(hashOpaqueValue(purchaseToken).length, 64);
});

test("expired purchase tokens are accepted only for verified order webhooks", () => {
  const purchaseToken = signDesignPurchaseToken({
    purchaseId: "purchase-expired",
    shop: "test.myshopify.com",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/2",
    principal: "gid://shopify/Customer/3",
    expiresAt: Math.floor(Date.now() / 1000) - 10,
  });

  assert.throws(
    () => verifyDesignPurchaseToken(purchaseToken),
    /expired/i,
  );
  assert.equal(
    verifyDesignPurchaseToken(purchaseToken, {
      allowExpired: true,
    }).purchaseId,
    "purchase-expired",
  );
});

test("Zakeke identity never contains customer contact data", () => {
  assert.deepEqual(
    zakekeIdentityForPrincipal("gid://shopify/Customer/123"),
    { customerCode: "shopify-123" },
  );
  assert.deepEqual(
    zakekeIdentityForPrincipal("visitor:abcdefghijklmnopqrstuvwxyz"),
    { visitorCode: "abcdefghijklmnopqrstuvwxyz" },
  );
  assert.throws(
    () => zakekeIdentityForPrincipal("customer@example.com"),
    /identity is invalid/i,
  );
});
