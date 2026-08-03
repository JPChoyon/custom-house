import { Prisma } from "@prisma/client";

export const CREATOR_COMMISSION_BASIS_POINTS = 1_000;

type MoneyInput = string | number | null | undefined;

type PaidOrderPayload = {
  id?: string | number;
  admin_graphql_api_id?: string;
  currency?: string;
  processed_at?: string;
  line_items?: Array<{
    id?: string | number;
    product_id?: string | number;
    variant_id?: string | number;
    title?: string;
    quantity?: number;
    price?: MoneyInput;
    discount_allocations?: Array<{ amount?: MoneyInput }>;
  }>;
};

type RefundPayload = {
  id?: string | number;
  order_id?: string | number;
  refund_line_items?: Array<{
    id?: string | number;
    line_item_id?: string | number;
    quantity?: number;
    subtotal?: MoneyInput;
  }>;
};

function gid(
  type: "Order" | "Product" | "ProductVariant",
  value: unknown,
) {
  const id = String(value || "").trim();
  if (id.startsWith(`gid://shopify/${type}/`)) return id;
  return /^\d+$/.test(id) ? `gid://shopify/${type}/${id}` : "";
}

function decimal(value: MoneyInput) {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(normalized)) return null;
  return new Prisma.Decimal(normalized);
}

function safeQuantity(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : 0;
}

export type CreatorPaidLine = {
  shopifyOrderId: string;
  shopifyLineItemId: string;
  shopifyProductId: string;
  shopifyVariantId: string | null;
  productTitle: string;
  quantity: number;
  currencyCode: string;
  grossSalesAmount: Prisma.Decimal;
  paidAt: Date | null;
};

export function parsePaidOrder(payload: unknown): CreatorPaidLine[] {
  const order = (payload || {}) as PaidOrderPayload;
  const shopifyOrderId = gid(
    "Order",
    order.admin_graphql_api_id || order.id,
  );
  const currencyCode = String(order.currency || "")
    .trim()
    .toUpperCase();
  const paidAt = order.processed_at ? new Date(order.processed_at) : null;
  if (
    !shopifyOrderId ||
    !/^[A-Z]{3}$/.test(currencyCode) ||
    (paidAt && Number.isNaN(paidAt.getTime()))
  ) {
    return [];
  }

  return (Array.isArray(order.line_items) ? order.line_items : []).flatMap(
    (line): CreatorPaidLine[] => {
      const shopifyLineItemId = String(line.id || "").trim();
      const shopifyProductId = gid("Product", line.product_id);
      const shopifyVariantId = gid("ProductVariant", line.variant_id) || null;
      const quantity = safeQuantity(line.quantity);
      const unitPrice = decimal(line.price);
      if (!shopifyLineItemId || !shopifyProductId || !quantity || !unitPrice) {
        return [];
      }
      const discount = (Array.isArray(line.discount_allocations)
        ? line.discount_allocations
        : []
      ).reduce(
        (total, allocation) =>
          total.plus(decimal(allocation.amount)?.abs() || 0),
        new Prisma.Decimal(0),
      );
      const subtotal = Prisma.Decimal.max(
        unitPrice.mul(quantity).minus(discount),
        0,
      );
      return [
        {
          shopifyOrderId,
          shopifyLineItemId,
          shopifyProductId,
          shopifyVariantId,
          productTitle: String(line.title || "Creator product")
            .trim()
            .slice(0, 255),
          quantity,
          currencyCode,
          grossSalesAmount: subtotal,
          paidAt,
        },
      ];
    },
  );
}

export type CreatorRefundLine = {
  adjustmentKey: string;
  shopifyOrderId: string;
  shopifyLineItemId: string;
  quantity: number;
  salesAmount: Prisma.Decimal;
};

export function parseRefund(payload: unknown): CreatorRefundLine[] {
  const refund = (payload || {}) as RefundPayload;
  const shopifyOrderId = gid("Order", refund.order_id);
  if (!shopifyOrderId) return [];
  return (Array.isArray(refund.refund_line_items)
    ? refund.refund_line_items
    : []
  ).flatMap((line): CreatorRefundLine[] => {
    const shopifyLineItemId = String(line.line_item_id || "").trim();
    const refundLineItemId = String(line.id || "").trim();
    const quantity = safeQuantity(line.quantity);
    const amount = decimal(line.subtotal)?.abs();
    if (!shopifyLineItemId || !refundLineItemId || !quantity || !amount) {
      return [];
    }
    return [
      {
        adjustmentKey: `refund-line:${refundLineItemId}`,
        shopifyOrderId,
        shopifyLineItemId,
        quantity,
        salesAmount: amount,
      },
    ];
  });
}

export function creatorEarning(
  salesAmount: Prisma.Decimal,
  commissionRateBps = CREATOR_COMMISSION_BASIS_POINTS,
) {
  return salesAmount.mul(commissionRateBps).div(10_000);
}
