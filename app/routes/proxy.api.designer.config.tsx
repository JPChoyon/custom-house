import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import {
  getDesignerConfig,
  publicDesignerConfig,
} from "../services/designer-config.server";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import {
  requireApprovedCreator,
  verifyDesignerProduct,
} from "../services/designer-session.server";
import { normalizeCustomerGid } from "../services/helium-sync.server";
import { proxyContext } from "../services/proxy.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request, false);
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId") ?? "";
    const variantId = url.searchParams.get("variantId") ?? "";
    const config = getDesignerConfig();
    await verifyDesignerProduct(client, config, productId, variantId);
    let creatorModeAvailable = false;
    if (customerId) {
      try {
        await requireApprovedCreator(shop, customerId);
        creatorModeAvailable = true;
      } catch {
        creatorModeAvailable = false;
      }
    }
    const existing = customerId
      ? await db.designSession.findMany({
          where: {
            shop,
            customerId: normalizeCustomerGid(customerId),
            shopifyProductId: productId,
            ...(creatorModeAvailable
              ? {}
              : { mode: "CUSTOMER_CUSTOMIZE" as const }),
          },
          select: {
            id: true,
            clientKey: true,
            mode: true,
            version: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 5,
        })
      : [];
    return designerApiSuccess({
      config: publicDesignerConfig(config),
      creatorModeAvailable,
      loggedIn: Boolean(customerId),
      recentSessions: existing,
    });
  } catch (error) {
    return designerApiError(error, "designer.config");
  }
}
