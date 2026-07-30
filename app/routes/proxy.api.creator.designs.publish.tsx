import type { ActionFunctionArgs } from "react-router";
import { publishCreatorDesign } from "../services/designer-publishing.server";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { jsonBody, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:designer-publish`, 5, 60 * 60 * 1000);
    const body = await jsonBody(request);
    const design = await publishCreatorDesign({
      shop,
      customerId: customerId!,
      sessionId: String(body.sessionId ?? ""),
      title: String(body.title ?? ""),
      client,
    });
    return designerApiSuccess({
      id: design.id,
      status: design.status,
      syncStatus: design.syncStatus,
      productId: design.shopifyCreatorProductId,
    });
  } catch (error) {
    return designerApiError(error, "designer.creator_publish");
  }
}

