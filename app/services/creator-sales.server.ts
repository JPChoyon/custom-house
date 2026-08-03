import { Prisma } from "@prisma/client";
import db from "../db.server";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import {
  CREATOR_COMMISSION_BASIS_POINTS,
  creatorEarning,
  parsePaidOrder,
  parseRefund,
  type CreatorPaidLine,
} from "./creator-sales";

type ProductOwnershipNode = {
  id: string;
  creatorId: { value: string } | null;
  collections: { nodes: Array<{ id: string }> };
};

function addCandidate(
  candidates: Map<string, Set<string>>,
  productId: string,
  creatorId: string,
) {
  const owners = candidates.get(productId) || new Set<string>();
  owners.add(creatorId);
  candidates.set(productId, owners);
}

async function resolveCreatorOwners(
  shop: string,
  productIds: string[],
  client?: ShopifyGraphqlClient,
) {
  const [designs, submissions, creators] = await Promise.all([
    db.creatorDesign.findMany({
      where: { shop, shopifyCreatorProductId: { in: productIds } },
      select: { shopifyCreatorProductId: true, creatorId: true },
    }),
    db.designSubmission.findMany({
      where: { shop, createdProductId: { in: productIds } },
      select: { createdProductId: true, creatorId: true },
    }),
    db.creator.findMany({
      where: { shop },
      select: { id: true, collectionId: true },
    }),
  ]);
  const creatorIds = new Set(creators.map((creator) => creator.id));
  const explicit = new Map<string, Set<string>>();
  for (const design of designs) {
    if (design.shopifyCreatorProductId) {
      addCandidate(explicit, design.shopifyCreatorProductId, design.creatorId);
    }
  }
  for (const submission of submissions) {
    if (submission.createdProductId) {
      addCandidate(explicit, submission.createdProductId, submission.creatorId);
    }
  }

  const collectionOwners = new Map(
    creators
      .filter((creator) => creator.collectionId)
      .map((creator) => [creator.collectionId!, creator.id]),
  );
  const collectionCandidates = new Map<string, Set<string>>();
  const productsNeedingShopifyLookup = productIds.filter(
    (productId) => !explicit.has(productId),
  );
  if (client && productsNeedingShopifyLookup.length) {
    const result = await client.request<{
      nodes: Array<ProductOwnershipNode | null>;
    }>(
      `#graphql query CreatorSaleProductOwnership($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            creatorId: metafield(namespace: "customhouse", key: "creator_id") {
              value
            }
            collections(first: 250) { nodes { id } }
          }
        }
      }`,
      { ids: productsNeedingShopifyLookup },
    );
    for (const product of result.nodes) {
      if (!product) continue;
      const metafieldCreatorId = product.creatorId?.value;
      if (metafieldCreatorId && creatorIds.has(metafieldCreatorId)) {
        addCandidate(explicit, product.id, metafieldCreatorId);
      }
      for (const collection of product.collections.nodes) {
        const owner = collectionOwners.get(collection.id);
        if (owner) addCandidate(collectionCandidates, product.id, owner);
      }
    }
  }

  return new Map(
    productIds.flatMap((productId): Array<[string, string]> => {
      const explicitOwners = explicit.get(productId);
      if (explicitOwners?.size === 1) {
        return [[productId, [...explicitOwners][0]]];
      }
      if (explicitOwners && explicitOwners.size > 1) return [];
      const manualOwners = collectionCandidates.get(productId);
      return manualOwners?.size === 1
        ? [[productId, [...manualOwners][0]]]
        : [];
    }),
  );
}

async function reconcilePendingAdjustments(sale: {
  id: string;
  shop: string;
  shopifyLineItemId: string;
  quantity: number;
  refundedQuantity: number;
  grossSalesAmount: Prisma.Decimal;
  refundedSalesAmount: Prisma.Decimal;
}) {
  await db.$transaction(async (tx) => {
    const pending = await tx.creatorSaleAdjustment.findMany({
      where: {
        shop: sale.shop,
        shopifyLineItemId: sale.shopifyLineItemId,
        creatorSaleId: null,
      },
    });
    if (!pending.length) return;
    const requestedAmount = pending.reduce(
      (total, adjustment) => total.plus(adjustment.salesAmount),
      new Prisma.Decimal(0),
    );
    const requestedQuantity = pending.reduce(
      (total, adjustment) => total + adjustment.quantity,
      0,
    );
    const availableAmount = Prisma.Decimal.max(
      sale.grossSalesAmount.minus(sale.refundedSalesAmount),
      0,
    );
    const availableQuantity = Math.max(
      sale.quantity - sale.refundedQuantity,
      0,
    );
    await tx.creatorSale.update({
      where: { id: sale.id },
      data: {
        refundedSalesAmount: {
          increment: Prisma.Decimal.min(requestedAmount, availableAmount),
        },
        refundedQuantity: {
          increment: Math.min(requestedQuantity, availableQuantity),
        },
      },
    });
    await tx.creatorSaleAdjustment.updateMany({
      where: { id: { in: pending.map((adjustment) => adjustment.id) } },
      data: { creatorSaleId: sale.id },
    });
  });
}

export async function recordPaidCreatorSales(input: {
  shop: string;
  payload: unknown;
  webhookId: string;
  client?: ShopifyGraphqlClient;
}) {
  const lines = parsePaidOrder(input.payload);
  if (!lines.length) return { created: 0, skipped: 0 };
  const productIds = [...new Set(lines.map((line) => line.shopifyProductId))];
  const owners = await resolveCreatorOwners(input.shop, productIds, input.client);
  let created = 0;
  for (const line of lines) {
    const creatorId = owners.get(line.shopifyProductId);
    if (!creatorId) continue;
    const result = await db.creatorSale.createMany({
      data: [
        {
          shop: input.shop,
          creatorId,
          ...line,
          commissionRateBps: CREATOR_COMMISSION_BASIS_POINTS,
          sourceWebhookId: input.webhookId,
        },
      ],
      skipDuplicates: true,
    });
    created += result.count;
    const sale = await db.creatorSale.findUnique({
      where: {
        shop_shopifyLineItemId: {
          shop: input.shop,
          shopifyLineItemId: line.shopifyLineItemId,
        },
      },
    });
    if (sale) await reconcilePendingAdjustments(sale);
  }
  const skipped = lines.length - created;
  if (created > 0) {
    await db.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "WEBHOOK",
        actorId: input.webhookId,
        action: "creator_sales.paid_recorded",
        entityType: "Order",
        entityId: lines[0]!.shopifyOrderId,
        afterJson: JSON.stringify({ created, skipped }),
      },
    });
  }
  console.info("creator_sales_paid_order", {
    shop: input.shop,
    orderId: lines[0]?.shopifyOrderId,
    lineCount: lines.length,
    created,
    skipped,
  });
  return { created, skipped };
}

export async function recordCreatorRefund(input: {
  shop: string;
  payload: unknown;
  webhookId: string;
}) {
  const lines = parseRefund(input.payload);
  let applied = 0;
  for (const line of lines) {
    await db.$transaction(async (tx) => {
      const duplicate = await tx.creatorSaleAdjustment.findUnique({
        where: {
          shop_adjustmentKey: {
            shop: input.shop,
            adjustmentKey: line.adjustmentKey,
          },
        },
      });
      if (duplicate) return;
      const sale = await tx.creatorSale.findUnique({
        where: {
          shop_shopifyLineItemId: {
            shop: input.shop,
            shopifyLineItemId: line.shopifyLineItemId,
          },
        },
      });
      const availableAmount = sale
        ? Prisma.Decimal.max(
            sale.grossSalesAmount.minus(sale.refundedSalesAmount),
            0,
          )
        : line.salesAmount;
      const availableQuantity = sale
        ? Math.max(sale.quantity - sale.refundedQuantity, 0)
        : line.quantity;
      const salesAmount = Prisma.Decimal.min(
        line.salesAmount,
        availableAmount,
      );
      const quantity = Math.min(line.quantity, availableQuantity);
      await tx.creatorSaleAdjustment.create({
        data: {
          shop: input.shop,
          ...line,
          salesAmount,
          quantity,
          creatorSaleId: sale?.id,
          sourceWebhookId: input.webhookId,
        },
      });
      if (sale) {
        await tx.creatorSale.update({
          where: { id: sale.id },
          data: {
            refundedSalesAmount: { increment: salesAmount },
            refundedQuantity: { increment: quantity },
          },
        });
        applied += 1;
      }
    });
  }
  console.info("creator_sales_refund", {
    shop: input.shop,
    lineCount: lines.length,
    applied,
  });
  if (applied > 0) {
    await db.auditLog.create({
      data: {
        shop: input.shop,
        actorType: "WEBHOOK",
        actorId: input.webhookId,
        action: "creator_sales.refund_recorded",
        entityType: "Order",
        entityId: lines[0]!.shopifyOrderId,
        afterJson: JSON.stringify({ applied, pending: lines.length - applied }),
      },
    });
  }
  return { applied, pending: lines.length - applied };
}

function formatMoney(amount: Prisma.Decimal, currencyCode: string) {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "code",
    }).format(amount.toNumber());
  } catch {
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

function netSales(sale: {
  grossSalesAmount: Prisma.Decimal;
  refundedSalesAmount: Prisma.Decimal;
}) {
  return Prisma.Decimal.max(
    sale.grossSalesAmount.minus(sale.refundedSalesAmount),
    0,
  );
}

export async function creatorSalesOverview(creatorId: string) {
  const [currencyGroups, orderIds, productGroups] = await Promise.all([
    db.creatorSale.groupBy({
      by: ["currencyCode"],
      where: { creatorId },
      _sum: {
        grossSalesAmount: true,
        refundedSalesAmount: true,
        quantity: true,
        refundedQuantity: true,
      },
    }),
    db.creatorSale.findMany({
      where: { creatorId },
      select: { shopifyOrderId: true },
      distinct: ["shopifyOrderId"],
    }),
    db.creatorSale.groupBy({
      by: ["shopifyProductId", "productTitle"],
      where: { creatorId },
      _sum: { quantity: true, refundedQuantity: true },
    }),
  ]);
  const ordersCount = orderIds.length;
  const itemsSoldCount = currencyGroups.reduce(
    (total, group) =>
      total +
      Math.max(
        (group._sum.quantity || 0) - (group._sum.refundedQuantity || 0),
        0,
      ),
    0,
  );
  const totals = new Map<
    string,
    { sales: Prisma.Decimal; earnings: Prisma.Decimal }
  >();
  for (const group of currencyGroups) {
    const amount = netSales({
      grossSalesAmount: group._sum.grossSalesAmount || new Prisma.Decimal(0),
      refundedSalesAmount:
        group._sum.refundedSalesAmount || new Prisma.Decimal(0),
    });
    totals.set(group.currencyCode, {
      sales: amount,
      earnings: creatorEarning(amount),
    });
  }
  const formatted = [...totals.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return {
    totalSales: formatted.length
      ? formatted
          .map(([currency, total]) => formatMoney(total.sales, currency))
          .join(" + ")
      : "0.00",
    totalEarnings: formatted.length
      ? formatted
          .map(([currency, total]) => formatMoney(total.earnings, currency))
          .join(" + ")
      : "0.00",
    ordersCount,
    itemsSoldCount,
    commissionRatePercent: CREATOR_COMMISSION_BASIS_POINTS / 100,
    topSellingProducts: productGroups
      .map((product) => ({
        title: product.productTitle,
        unitsSold: Math.max(
          (product._sum.quantity || 0) -
            (product._sum.refundedQuantity || 0),
          0,
        ),
      }))
      .filter((product) => product.unitsSold > 0)
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, 5),
  };
}

export type { CreatorPaidLine };
