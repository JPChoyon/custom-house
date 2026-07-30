import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const gid = `gid://shopify/Product/${String(
    (payload as { id?: number | string }).id ?? "",
  )}`;
  await db.$transaction([
    db.designSubmission.updateMany({
      where: { shop, createdProductId: gid },
      data: {
        status: "ARCHIVED",
        publishError: "Published Shopify product was deleted.",
      },
    }),
    db.designSubmission.updateMany({
      where: { shop, baseProductId: gid, status: "PENDING" },
      data: {
        status: "ARCHIVED",
        publishError: "Base Shopify product was deleted.",
      },
    }),
    db.creatorDesign.updateMany({
      where: { shop, shopifyCreatorProductId: gid },
      data: {
        shopifyCreatorProductId: null,
        status: "FAILED",
        syncStatus: "FAILED",
        publishError:
          "The generated Shopify product was deleted. Retry to recreate it.",
      },
    }),
    db.creatorDesign.updateMany({
      where: { shop, globalShopifyProductId: gid },
      data: {
        status: "FAILED",
        syncStatus: "FAILED",
        publishError: "The configured base product was deleted.",
      },
    }),
    db.designSession.updateMany({
      where: { shop, shopifyProductId: gid },
      data: { status: "FAILED" },
    }),
    db.globalProductMapping.updateMany({
      where: { shop, shopifyProductId: gid },
      data: { enabled: false, status: "DISABLED" },
    }),
  ]);
  return new Response();
}
