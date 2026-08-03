import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATOR_COMMISSION_BASIS_POINTS,
  creatorEarning,
  parsePaidOrder,
  parseRefund,
} from "../app/services/creator-sales.ts";
import { shouldRedirectToCreatorDashboard } from "../extensions/customhouse-creator-storefront/assets/creator-application-guard.js";

test("paid creator sales use the discounted line subtotal", () => {
  const lines = parsePaidOrder({
    id: 101,
    currency: "SEK",
    processed_at: "2026-08-03T10:00:00Z",
    line_items: [
      {
        id: 201,
        product_id: 301,
        variant_id: 401,
        title: "Creator shirt",
        quantity: 2,
        price: "100.00",
        discount_allocations: [{ amount: "20.00" }],
      },
    ],
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.shopifyOrderId, "gid://shopify/Order/101");
  assert.equal(lines[0]?.shopifyProductId, "gid://shopify/Product/301");
  assert.equal(lines[0]?.grossSalesAmount.toFixed(2), "180.00");
  assert.equal(lines[0]?.currencyCode, "SEK");
});

test("creator earnings are exactly ten percent of attributed net sales", () => {
  const [line] = parsePaidOrder({
    id: 1,
    currency: "SEK",
    line_items: [
      { id: 2, product_id: 3, quantity: 1, price: "123.45" },
    ],
  });
  assert.equal(CREATOR_COMMISSION_BASIS_POINTS, 1_000);
  assert.equal(
    creatorEarning(line!.grossSalesAmount).toFixed(3),
    "12.345",
  );
});

test("refund line items are normalized for idempotent sales adjustments", () => {
  const lines = parseRefund({
    id: 501,
    order_id: 101,
    refund_line_items: [
      {
        id: 601,
        line_item_id: 201,
        quantity: 1,
        subtotal: "-50.00",
      },
    ],
  });
  assert.deepEqual(
    lines.map((line) => ({
      key: line.adjustmentKey,
      order: line.shopifyOrderId,
      line: line.shopifyLineItemId,
      amount: line.salesAmount.toFixed(2),
    })),
    [
      {
        key: "refund-line:601",
        order: "gid://shopify/Order/101",
        line: "201",
        amount: "50.00",
      },
    ],
  );
});

test("invalid or unattributable webhook money data is rejected", () => {
  assert.deepEqual(
    parsePaidOrder({
      id: 1,
      currency: "SEK",
      line_items: [{ id: 2, product_id: 3, quantity: 1, price: "secret" }],
    }),
    [],
  );
  assert.deepEqual(parseRefund({ order_id: 1, refund_line_items: [] }), []);
});

test("application guard redirects existing creator states only", () => {
  for (const state of [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "SUSPENDED",
    "SYNC_CONFLICT",
  ]) {
    assert.equal(shouldRedirectToCreatorDashboard({ state }), true);
  }
  for (const state of [
    "NOT_APPLIED",
    "APPLICATION_NOT_SUBMITTED",
    "CREATOR_RECORD_MISSING",
    "LOGGED_OUT",
  ]) {
    assert.equal(shouldRedirectToCreatorDashboard({ state }), false);
  }
});

test("storefront creator login returns to the creator dashboard", () => {
  const guard = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-application-guard.liquid",
    "utf8",
  );
  const dashboard = readFileSync(
    "extensions/customhouse-creator-storefront/blocks/creator-dashboard.liquid",
    "utf8",
  );

  for (const source of [guard, dashboard]) {
    assert.match(source, /\/customer_authentication\/login\?return_to=/);
    assert.doesNotMatch(source, /return_url=/);
  }
  assert.match(guard, /default: '\/pages\/creator-dashboard'/);
});

test("production configuration subscribes to paid sales and refunds", () => {
  const config = readFileSync("shopify.app.production.toml", "utf8");
  assert.match(config, /read_orders/);
  assert.match(config, /topics = \["orders\/create"\]/);
  assert.match(config, /topics = \["orders\/paid"\]/);
  assert.match(config, /topics = \["refunds\/create"\]/);
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /@@unique\(\[shop, shopifyLineItemId\]\)/);
  assert.match(schema, /commissionRateBps\s+Int\s+@default\(1000\)/);
});
