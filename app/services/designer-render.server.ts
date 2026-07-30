import type { DesignerProductConfig } from "./designer-config.server";
import { DomainError } from "./domain.ts";
import {
  validateDesignAssetUrls,
  validateDesignJson,
} from "./designer-validation.ts";

function pngBuffer(dataUrl: string) {
  const encoded = dataUrl.match(/^data:image\/png;base64,(.+)$/)?.[1];
  if (!encoded) {
    throw new DomainError(
      "DESIGN_EXPORT_FAILED",
      "The design artwork could not be exported.",
      422,
    );
  }
  return Buffer.from(encoded, "base64");
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DomainError("DESIGN_ASSET_LOAD_FAILED", message, 422),
            ),
          12_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function renderDesignerArtifacts(
  serialized: string,
  config: DesignerProductConfig,
) {
  const design = validateDesignJson(serialized);
  validateDesignAssetUrls(design, ["cdn.shopify.com"]);
  const [fabric, nodeCanvas] = await Promise.all([
    import("fabric/node"),
    import("canvas"),
  ]);
  const canvas = new fabric.StaticCanvas(undefined, {
    width: config.canvasWidth,
    height: config.canvasHeight,
    renderOnAddRemove: false,
  });
  try {
    await withTimeout(
      canvas.loadFromJSON(design),
      "One of the design images could not be loaded.",
    );
    canvas.clipPath = new fabric.Rect({
      left: config.printArea.x,
      top: config.printArea.y,
      width: config.printArea.width,
      height: config.printArea.height,
      absolutePositioned: true,
    });
    canvas.renderAll();
    const artwork = pngBuffer(
      canvas.toDataURL({
        format: "png",
        left: config.printArea.x,
        top: config.printArea.y,
        width: config.printArea.width,
        height: config.printArea.height,
        multiplier: config.exportWidth / config.printArea.width,
        enableRetinaScaling: false,
      }),
    );
    const fullArtwork = await withTimeout(
      nodeCanvas.loadImage(
        canvas.toDataURL({
          format: "png",
          multiplier: 1,
          enableRetinaScaling: false,
        }),
      ),
      "The design preview could not be rendered.",
    );
    const mockup = await withTimeout(
      nodeCanvas.loadImage(config.mockupImageUrl),
      "The product mockup could not be loaded.",
    );
    const previewCanvas = nodeCanvas.createCanvas(
      config.canvasWidth,
      config.canvasHeight,
    );
    const context = previewCanvas.getContext("2d");
    context.drawImage(mockup, 0, 0, config.canvasWidth, config.canvasHeight);
    context.drawImage(fullArtwork, 0, 0, config.canvasWidth, config.canvasHeight);
    return {
      artwork: new Uint8Array(artwork),
      preview: new Uint8Array(previewCanvas.toBuffer("image/png")),
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "DESIGN_EXPORT_FAILED",
      "We could not export this design. Check the artwork and try again.",
      422,
    );
  } finally {
    canvas.dispose();
  }
}
