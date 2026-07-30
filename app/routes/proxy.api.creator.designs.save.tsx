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
  requireApprovedCreator,
  saveDesignSession,
  verifyDesignerProduct,
} from "../services/designer-session.server";
import { storeDesignerImage } from "../services/designer-storage.server";
import { validateDesignJson } from "../services/designer-validation";
import { proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:designer-save`, 20, 60 * 60 * 1000);
    const creator = await requireApprovedCreator(shop, customerId!);
    const config = getDesignerConfig();
    const form = await request.formData();
    const productId = String(form.get("productId") ?? "");
    const variantId = String(form.get("variantId") ?? "");
    const designJson = String(form.get("designJson") ?? "");
    const clientKey = String(form.get("clientKey") ?? "");
    const sessionId = String(form.get("sessionId") ?? "") || undefined;
    const expectedVersion = Number(form.get("expectedVersion") ?? 0);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new DomainError("DESIGN_VERSION_INVALID", "The design version is invalid.", 422);
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
        fileName: `creator-preview-${clientKey}.png`,
        mimeType: "image/png",
        alt: `Creator design preview by ${creator.displayName}`,
      }),
      storeDesignerImage(client, {
        bytes: rendered.artwork,
        fileName: `creator-artwork-${clientKey}.png`,
        mimeType: "image/png",
        alt: `Creator print artwork by ${creator.displayName}`,
      }),
    ]);
    const session = await saveDesignSession({
      shop,
      customerId: customerId!,
      creatorId: creator.id,
      sessionId,
      clientKey,
      expectedVersion,
      productId,
      variantId,
      mode: "CREATOR_PUBLISH",
      designJson,
      previewUrl: storedPreview.url,
      artworkUrl: storedArtwork.url,
      status: "DRAFT",
    });
    return designerApiSuccess({
      id: session.id,
      version: session.version,
      savedAt: session.updatedAt,
    });
  } catch (error) {
    return designerApiError(error, "designer.creator_save");
  }
}
