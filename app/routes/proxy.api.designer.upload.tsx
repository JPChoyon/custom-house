import type { ActionFunctionArgs } from "react-router";
import { getDesignerConfig } from "../services/designer-config.server";
import {
  designerApiError,
  designerApiSuccess,
  requireFormFile,
} from "../services/designer-api.server";
import { storeDesignerImage } from "../services/designer-storage.server";
import { validateImageUpload } from "../services/designer-validation";
import { verifyDesignerProduct } from "../services/designer-session.server";
import { proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:designer-upload`, 20, 60 * 60 * 1000);
    const config = getDesignerConfig();
    const form = await request.formData();
    const productId = String(form.get("productId") ?? "");
    const variantId = String(form.get("variantId") ?? "");
    await verifyDesignerProduct(client, config, productId, variantId);
    const file = requireFormFile(form, "image");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = validateImageUpload(bytes, file.name, file.type, {
      maximumBytes: config.maximumUploadBytes,
      minimumWidth: config.minimumUploadWidth,
      minimumHeight: config.minimumUploadHeight,
      allowedTypes: config.allowedFileTypes,
    });
    const stored = await storeDesignerImage(client, {
      bytes,
      fileName: file.name,
      mimeType: info.mimeType,
      alt: "Custom House customer design source",
    });
    return designerApiSuccess(
      { url: stored.url, width: info.width, height: info.height },
      201,
    );
  } catch (error) {
    return designerApiError(error, "designer.upload");
  }
}

