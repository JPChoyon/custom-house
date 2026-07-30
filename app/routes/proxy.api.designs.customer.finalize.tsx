import type { ActionFunctionArgs } from "react-router";
import { DomainError } from "../services/domain";
import { getDesignerConfig } from "../services/designer-config.server";
import {
  designerApiError,
  designerApiSuccess,
} from "../services/designer-api.server";
import { renderDesignerArtifacts } from "../services/designer-render.server";
import {
  assertDesignSessionVersion,
  numericVariantId,
  saveDesignSession,
  verifyDesignerProduct,
} from "../services/designer-session.server";
import { storeDesignerImage } from "../services/designer-storage.server";
import { signDesignCartToken } from "../services/designer-token.server";
import { validateDesignJson } from "../services/designer-validation";
import { proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:designer-finalize`, 8, 60 * 60 * 1000);
    const config = getDesignerConfig();
    const form = await request.formData();
    const productId = String(form.get("productId") ?? "");
    const variantId = String(form.get("variantId") ?? "");
    const designJson = String(form.get("designJson") ?? "");
    const clientKey = String(form.get("clientKey") ?? "");
    const sessionId = String(form.get("sessionId") ?? "") || undefined;
    const expectedVersion = Number(form.get("expectedVersion") ?? 0);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new DomainError(
        "DESIGN_VERSION_INVALID",
        "The design version is invalid.",
        422,
      );
    }
    validateDesignJson(designJson);
    await verifyDesignerProduct(client, config, productId, variantId);
    await assertDesignSessionVersion({
      shop,
      customerId: customerId!,
      sessionId,
      expectedVersion,
    });
    const rendered = await renderDesignerArtifacts(designJson, config);
    const [storedPreview, storedArtwork] = await Promise.all([
      storeDesignerImage(client, {
        bytes: rendered.preview,
        fileName: `preview-${clientKey}.png`,
        mimeType: "image/png",
        alt: "Custom House customized product preview",
      }),
      storeDesignerImage(client, {
        bytes: rendered.artwork,
        fileName: `artwork-${clientKey}.png`,
        mimeType: "image/png",
        alt: "Custom House transparent print artwork",
      }),
    ]);
    const session = await saveDesignSession({
      shop,
      customerId: customerId!,
      sessionId,
      clientKey,
      expectedVersion,
      productId,
      variantId,
      mode: "CUSTOMER_CUSTOMIZE",
      designJson,
      previewUrl: storedPreview.url,
      artworkUrl: storedArtwork.url,
      status: "READY",
    });
    const token = signDesignCartToken({
      designId: session.id,
      version: session.version,
      shop,
      productId,
      variantId,
    });
    return designerApiSuccess({
      designSession: { id: session.id, version: session.version },
      cart: {
        id: numericVariantId(variantId),
        quantity: 1,
        properties: {
          _custom_house_mode: "customer_customized",
          _custom_house_design_id: session.id,
          _custom_house_design_version: String(session.version),
          _custom_house_design_token: token,
        },
      },
    });
  } catch (error) {
    return designerApiError(error, "designer.customer_finalize");
  }
}
