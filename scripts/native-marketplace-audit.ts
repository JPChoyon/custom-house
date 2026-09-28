import db from "../app/db.server";
import { readFileSync } from "node:fs";
import { unauthenticated } from "../app/shopify.server";
import { AdminGraphqlClient } from "../app/services/shopify-graphql.server";
import {
  classifyPublishedCreatorProduct,
  type PublishedCreatorProductAuditCategory,
} from "./native-marketplace-audit-classifier.ts";

type CandidateCollection = {
  id: string;
  handle: string;
  title: string;
  creatorId: { value: string } | null;
  creatorCollectionId: { value: string } | null;
  productsCount: { count: number };
};

type ProductCustomizationState = {
  id: string;
  handle: string;
  productOrigin: { value: string } | null;
  designMode: { value: string } | null;
  designStatus: { value: string } | null;
  productType: { value: string } | null;
  creatorId: { value: string } | null;
  creatorProductId: { value: string } | null;
  creatorCartValidation: { jsonValue: unknown } | null;
  pitchprintDesignId: { value: string } | null;
  pitchprintEnabled: { value: string } | null;
  inkybayEnabled: { value: string } | null;
  legacyPitchprintDesignId: { value: string } | null;
  legacyPitchprintEnabled: { value: string } | null;
  legacyInkybayEnabled: { value: string } | null;
  variants: Array<{
    id: string;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
};

type ProductCustomizationStatePage = Omit<ProductCustomizationState, "variants"> & {
  variants: {
    nodes: ProductCustomizationState["variants"];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

function loadEnvFile() {
  try {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1]!.trim()]) {
        process.env[match[1]!.trim()] = match[2]!;
      }
    }
  } catch {
    // Runtime environments can provide env vars directly.
  }
}

function collectionUrl(handle: string | null | undefined) {
  return handle ? `/collections/${encodeURIComponent(handle)}` : null;
}

async function collectionDetails(
  client: AdminGraphqlClient,
  collectionId: string | null | undefined,
  productIds: string[],
) {
  if (!collectionId) return null;
  const result = await client.request<{
    collection: (CandidateCollection & {
      publishedOnPublication: boolean;
      products: { nodes: Array<{ id: string }> };
    }) | null;
  }>(
    `#graphql query NativeMarketplaceCollectionDetails(
      $id: ID!,
      $publicationId: ID!
    ) {
      collection(id: $id) {
        id
        handle
        title
        creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
        creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        productsCount { count }
        publishedOnPublication(publicationId: $publicationId)
        products(first: 100) { nodes { id } }
      }
    }`,
    {
      id: collectionId,
      publicationId: process.env.ONLINE_STORE_PUBLICATION_ID || "",
    },
  );
  const productSet = new Set(result.collection?.products.nodes.map((item) => item.id));
  return result.collection
    ? {
        ...result.collection,
        expectedProductsPresent: productIds.filter((id) => productSet.has(id)),
        expectedProductsMissing: productIds.filter((id) => !productSet.has(id)),
      }
    : null;
}

async function canonicalCandidates(
  client: AdminGraphqlClient,
  creatorId: string,
  creatorCollectionId: string,
) {
  const result = await client.request<{
    byCollection: { nodes: CandidateCollection[] };
    byCreator: { nodes: CandidateCollection[] };
  }>(
    `#graphql query NativeMarketplaceCanonicalCandidates($collectionQuery: String!, $creatorQuery: String!) {
      byCollection: collections(first: 10, query: $collectionQuery) {
        nodes {
          id handle title productsCount { count }
          creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
          creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        }
      }
      byCreator: collections(first: 10, query: $creatorQuery) {
        nodes {
          id handle title productsCount { count }
          creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
          creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
        }
      }
    }`,
    {
      collectionQuery: `metafields.customhouse.creator_collection_id:${creatorCollectionId}`,
      creatorQuery: `metafields.customhouse.creator_id:${creatorId}`,
    },
  );
  const byId = new Map<string, CandidateCollection>();
  for (const item of [...result.byCollection.nodes, ...result.byCreator.nodes]) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function titleCandidates(client: AdminGraphqlClient, name: string) {
  const terms = [
    name,
    `${name} Designs`,
    `Designs by ${name}`,
  ];
  const found = new Map<string, CandidateCollection>();
  for (const term of terms) {
    const result = await client.request<{
      collections: { nodes: CandidateCollection[] };
    }>(
      `#graphql query NativeMarketplaceTitleCandidates($query: String!) {
        collections(first: 20, query: $query) {
          nodes {
            id handle title productsCount { count }
            creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
            creatorCollectionId: metafield(namespace: "customhouse", key: "creator_collection_id") { value }
          }
        }
      }`,
      { query: `title:*${term}*` },
    );
    for (const item of result.collections.nodes) found.set(item.id, item);
  }
  return [...found.values()];
}

async function productCustomizationState(
  client: AdminGraphqlClient,
  productId: string,
) {
  const variants: ProductCustomizationState["variants"] = [];
  let cursor: string | null = null;
  let productState: Omit<ProductCustomizationState, "variants"> | null = null;
  do {
    const result: { product: ProductCustomizationStatePage | null } =
      await client.request(
    `#graphql query NativeMarketplaceProductCustomizationState($id: ID!, $cursor: String) {
      product(id: $id) {
        id
        handle
        productOrigin: metafield(namespace: "customhouse", key: "product_origin") { value }
        designMode: metafield(namespace: "customhouse", key: "design_mode") { value }
        designStatus: metafield(namespace: "customhouse", key: "design_status") { value }
        productType: metafield(namespace: "customhouse", key: "product_type") { value }
        creatorId: metafield(namespace: "customhouse", key: "creator_id") { value }
        creatorProductId: metafield(namespace: "customhouse", key: "creator_product_id") { value }
        creatorCartValidation: metafield(namespace: "customhouse", key: "creator_cart_validation") { jsonValue }
        pitchprintDesignId: metafield(namespace: "customhouse", key: "pitchprint_design_id") { value }
        pitchprintEnabled: metafield(namespace: "customhouse", key: "pitchprint_enabled") { value }
        inkybayEnabled: metafield(namespace: "customhouse", key: "inkybay_enabled") { value }
        legacyPitchprintDesignId: metafield(namespace: "pitchprint", key: "design_id") { value }
        legacyPitchprintEnabled: metafield(namespace: "pitchprint", key: "enabled") { value }
        legacyInkybayEnabled: metafield(namespace: "inkybay", key: "enabled") { value }
        variants(first: 250, after: $cursor) {
          nodes { id selectedOptions { name value } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    { id: productId, cursor },
      );
    if (!result.product) return null;
    const { variants: variantPage, ...state } = result.product;
    productState = state;
    variants.push(...variantPage.nodes);
    cursor = variantPage.pageInfo.hasNextPage
      ? variantPage.pageInfo.endCursor
      : null;
  } while (cursor);
  return productState ? { ...productState, variants } : null;
}

function creatorSetup(value: string) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { fixedColor: null, fixedProductionMethod: null };
    }
    const setup = parsed as Record<string, unknown>;
    return {
      fixedColor:
        typeof setup.fixedColor === "string" ? setup.fixedColor : null,
      fixedProductionMethod:
        typeof setup.productionMethod === "string"
          ? setup.productionMethod
          : typeof setup.fixedProductionMethod === "string"
            ? setup.fixedProductionMethod
            : null,
    };
  } catch {
    return { fixedColor: null, fixedProductionMethod: null };
  }
}

async function main() {
  loadEnvFile();
  if (!process.env.SHOPIFY_APP_URL?.startsWith("https://")) {
    process.env.SHOPIFY_APP_URL = "https://custom-house.vercel.app";
  }
  const shop =
    process.argv.find((arg) => arg.startsWith("--shop="))?.slice(7) ||
    process.env.SHOP;
  if (!shop) throw new Error("Pass --shop=<myshopify-domain>.");
  const onlyCreator = process.argv.find((arg) => arg.startsWith("--creator="))?.slice(10);
  const titleSearch = process.argv.find((arg) => arg.startsWith("--title-search="))?.slice(15);
  const config = await db.shopConfig.findUnique({
    where: { shop },
    select: { onlineStorePublicationId: true },
  });
  if (config?.onlineStorePublicationId) {
    process.env.ONLINE_STORE_PUBLICATION_ID = config.onlineStorePublicationId;
  }
  const { admin } = await unauthenticated.admin(shop);
  const client = new AdminGraphqlClient(admin);
  const creators = await db.creator.findMany({
    where: {
      shop,
      status: "APPROVED",
      ...(onlyCreator
        ? {
            OR: [
              { id: onlyCreator },
              { handle: onlyCreator },
              { displayName: { contains: onlyCreator, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      displayName: true,
      handle: true,
      collectionId: true,
      marketplaceCollection: true,
      creatorProducts: {
        where: { status: "PUBLISHED" },
        select: {
          id: true,
          title: true,
          publishedShopifyProductId: true,
          publishedShopifyProductHandle: true,
          publishedShopifyProductUrl: true,
          designVariantSelectionsJson: true,
        },
      },
    },
    orderBy: { displayName: "asc" },
  });
  let inconsistent = 0;
  const creatorReports = [];
  const creatorProductReports = [];
  const productCategoryCounts: Record<PublishedCreatorProductAuditCategory, number> = {
    OK: 0,
    NEEDS_REPUBLISH: 0,
    NEEDS_REPAIR: 0,
    MISSING_MAPPING: 0,
  };
  for (const creator of creators) {
    const collection = creator.marketplaceCollection;
    const productIds = creator.creatorProducts
      .map((product) => product.publishedShopifyProductId)
      .filter((id): id is string => Boolean(id));
    const details = await collectionDetails(
      client,
      collection?.shopifyCollectionId,
      productIds,
    );
    const candidates = collection
      ? await canonicalCandidates(client, creator.id, collection.id)
      : [];
    const duplicateCanonicalCandidates = candidates.filter(
      (item) =>
        item.creatorId?.value === creator.id ||
        item.creatorCollectionId?.value === collection?.id,
    );
    const canonicalCandidateIds = duplicateCanonicalCandidates.map((item) => item.id);
    const issues = [
      !collection ? "missing CreatorCollection row" : null,
      collection && !collection.shopifyCollectionId
        ? "missing canonical Shopify collection mapping"
        : null,
      details && details.creatorId?.value !== creator.id
        ? "canonical Shopify collection creator_id mismatch"
        : null,
      details && details.creatorCollectionId?.value !== collection?.id
        ? "canonical Shopify collection creator_collection_id mismatch"
        : null,
      details?.expectedProductsMissing.length
        ? "published native products missing from canonical collection"
        : null,
      canonicalCandidateIds.length > 1
        ? "multiple canonical-metafield collection candidates"
        : null,
    ].filter(Boolean);
    if (issues.length) inconsistent += 1;
    for (const product of creator.creatorProducts) {
      const setup = creatorSetup(product.designVariantSelectionsJson);
      const state = product.publishedShopifyProductId
        ? await productCustomizationState(client, product.publishedShopifyProductId)
        : null;
      const classification = classifyPublishedCreatorProduct({
        creatorProductId: product.id,
        shopifyProductId: product.publishedShopifyProductId,
        fixedColor: setup.fixedColor,
        fixedProductionMethod: setup.fixedProductionMethod,
        shopifyProduct: state
          ? {
              variants: state.variants,
              productOrigin: state.productOrigin?.value || null,
              designMode: state.designMode?.value || null,
              designStatus: state.designStatus?.value || null,
              productType: state.productType?.value || null,
              creatorProductId: state.creatorProductId?.value || null,
              creatorCartValidation:
                state.creatorCartValidation?.jsonValue ?? null,
            }
          : null,
      });
      productCategoryCounts[classification.category] += 1;
      const triggerValues = state
        ? [
            state.pitchprintDesignId?.value,
            state.pitchprintEnabled?.value,
            state.inkybayEnabled?.value,
            state.legacyPitchprintDesignId?.value,
            state.legacyPitchprintEnabled?.value,
            state.legacyInkybayEnabled?.value,
          ].filter(Boolean)
        : [];
      creatorProductReports.push({
        creatorProductId: product.id,
        creatorId: creator.id,
        shopifyProductId: product.publishedShopifyProductId,
        fixedColor: setup.fixedColor,
        fixedProductionMethod: setup.fixedProductionMethod,
        shopifyVariantCount: classification.variantCount,
        allVariantsMatchFixedColor:
          classification.allVariantsMatchFixedColor,
        canonicalMetafieldsPresent:
          classification.canonicalMetafieldsPresent,
        validationContractPresent:
          classification.validationContractPresent,
        category: classification.category,
        issues: classification.issues,
        productHandle: state?.handle || product.publishedShopifyProductHandle || null,
        product_origin: state?.productOrigin?.value || null,
        design_mode: state?.designMode?.value || null,
        design_status: state?.designStatus?.value || null,
        product_type: state?.productType?.value || null,
        creator_id: state?.creatorId?.value || null,
        creator_product_id: state?.creatorProductId?.value || null,
        pitchprintDesignIdPresent: Boolean(
          state?.pitchprintDesignId?.value || state?.legacyPitchprintDesignId?.value,
        ),
        customizationTriggerPresent: triggerValues.length > 0,
        customizeExpected:
          state?.productOrigin?.value === "creator" &&
          state?.designMode?.value === "buy_only" &&
          state?.designStatus?.value === "published"
            ? "NO"
            : "UNKNOWN",
      });
    }
    creatorReports.push({
      creatorId: creator.id,
      displayName: creator.displayName,
      legacyCreatorCollectionId: creator.collectionId,
      creatorCollectionId: collection?.id || null,
      creatorCollectionDisplayName: collection?.displayName || null,
      canonicalShopifyCollectionId: collection?.shopifyCollectionId || null,
      canonicalShopifyCollectionHandle:
        details?.handle || collection?.shopifyCollectionHandle || null,
      canonicalCollectionUrl:
        collectionUrl(details?.handle || collection?.shopifyCollectionHandle),
      publishedCreatorProductCount: creator.creatorProducts.length,
      mappedNativeShopifyProductCount: productIds.length,
      nativeProductsMissingFromCanonicalCollection:
        details?.expectedProductsMissing || [],
      duplicateCanonicalCandidates,
      issues,
    });
  }
  const titleCandidateReport = titleSearch
    ? await titleCandidates(client, titleSearch)
    : [];
  const report = {
    shop,
    creatorsChecked: creatorReports.length,
    consistentCreators: creatorReports.length - inconsistent,
    inconsistentCreators: inconsistent,
    creatorProductCategoryCounts: productCategoryCounts,
    creators: creatorReports,
    creatorProducts: creatorProductReports,
    titleCandidates: titleCandidateReport,
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    inconsistent > 0 ||
    productCategoryCounts.NEEDS_REPUBLISH > 0 ||
    productCategoryCounts.NEEDS_REPAIR > 0 ||
    productCategoryCounts.MISSING_MAPPING > 0
  ) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
