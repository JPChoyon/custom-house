import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { DomainError } from "../services/domain";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { normalizeCustomerGid } from "../services/helium-sync.server";
import { proxyContext } from "../services/proxy.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const { shop, customerId } = await proxyContext(request);
    const session = await db.designSession.findFirst({
      where: {
        id: params.sessionId,
        shop,
        customerId: normalizeCustomerGid(customerId!),
      },
      select: {
        id: true,
        clientKey: true,
        shopifyProductId: true,
        shopifyVariantId: true,
        mode: true,
        designJson: true,
        previewUrl: true,
        artworkUrl: true,
        status: true,
        version: true,
        updatedAt: true,
      },
    });
    if (!session) {
      throw new DomainError(
        "DESIGN_SESSION_MISSING",
        "The design session could not be found.",
        404,
      );
    }
    return designerApiSuccess(session);
  } catch (error) {
    return designerApiError(error, "designer.session_load");
  }
}
