import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { canHandleMutatingWebhook, sanitizedPreviewSkip } from "../services/environment-safety.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const gid = `gid://shopify/Collection/${String(
    (payload as { id?: number | string }).id ?? "",
  )}`;
  if (!canHandleMutatingWebhook({ shop, resourceType: "collection", resourceId: gid })) {
    sanitizedPreviewSkip(shop, "collections/delete", "PREVIEW_COLLECTION_MUTATION_DENIED");
    return new Response();
  }
  await db.$transaction([
    db.creator.updateMany({
      where: { shop, collectionId: gid },
      data: { collectionId: null },
    }),
    db.creatorDesign.updateMany({
      where: { shop, shopifyCollectionId: gid },
      data: {
        shopifyCollectionId: null,
        status: "FAILED",
        syncStatus: "FAILED",
        publishError:
          "The creator collection was deleted. Retry to recreate it.",
      },
    }),
  ]);
  return new Response();
}
