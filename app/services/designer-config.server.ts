import { DomainError } from "./domain";

export type DesignerMode = "CUSTOMER_CUSTOMIZE" | "CREATOR_PUBLISH";

export type DesignerProductConfig = {
  shopifyProductId: string;
  mockupImageUrl: string;
  canvasWidth: number;
  canvasHeight: number;
  printArea: { x: number; y: number; width: number; height: number };
  exportWidth: number;
  exportHeight: number;
  minimumUploadWidth: number;
  minimumUploadHeight: number;
  maximumUploadBytes: number;
  allowedFileTypes: readonly string[];
  allowedVariantIds: readonly string[];
};

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function isDesignerEnabled() {
  return process.env.CUSTOM_HOUSE_DESIGNER_ENABLED === "true";
}

export function getDesignerConfig(): DesignerProductConfig {
  if (!isDesignerEnabled()) {
    throw new DomainError(
      "DESIGNER_DISABLED",
      "Product customization is not available.",
      404,
    );
  }
  const shopifyProductId = process.env.CUSTOM_HOUSE_DESIGNER_PRODUCT_ID?.trim() ?? "";
  const mockupImageUrl = process.env.CUSTOM_HOUSE_DESIGNER_MOCKUP_URL?.trim() ?? "";
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyProductId)) {
    throw new DomainError(
      "DESIGNER_NOT_CONFIGURED",
      "The product customizer is not configured.",
      503,
    );
  }
  let mockup: URL;
  try {
    mockup = new URL(mockupImageUrl);
  } catch {
    throw new DomainError(
      "DESIGNER_NOT_CONFIGURED",
      "The product customizer is not configured.",
      503,
    );
  }
  if (mockup.protocol !== "https:" || mockup.username || mockup.password) {
    throw new DomainError(
      "DESIGNER_NOT_CONFIGURED",
      "The product customizer is not configured.",
      503,
    );
  }
  const canvasWidth = integerEnv("CUSTOM_HOUSE_DESIGNER_CANVAS_WIDTH", 900, 320, 2400);
  const canvasHeight = integerEnv("CUSTOM_HOUSE_DESIGNER_CANVAS_HEIGHT", 1100, 320, 2400);
  const x = integerEnv("CUSTOM_HOUSE_DESIGNER_PRINT_X", 250, 0, canvasWidth - 1);
  const y = integerEnv("CUSTOM_HOUSE_DESIGNER_PRINT_Y", 250, 0, canvasHeight - 1);
  const width = integerEnv(
    "CUSTOM_HOUSE_DESIGNER_PRINT_WIDTH",
    400,
    100,
    canvasWidth - x,
  );
  const height = integerEnv(
    "CUSTOM_HOUSE_DESIGNER_PRINT_HEIGHT",
    500,
    100,
    canvasHeight - y,
  );
  const allowedVariantIds = (process.env.CUSTOM_HOUSE_DESIGNER_ALLOWED_VARIANTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value));
  const exportWidth = integerEnv(
    "CUSTOM_HOUSE_DESIGNER_EXPORT_WIDTH",
    2400,
    500,
    6000,
  );
  const exportHeight = integerEnv(
    "CUSTOM_HOUSE_DESIGNER_EXPORT_HEIGHT",
    3000,
    500,
    6000,
  );
  if (Math.abs(width / height - exportWidth / exportHeight) > 0.0001) {
    throw new DomainError(
      "DESIGNER_NOT_CONFIGURED",
      "The designer print and export aspect ratios must match.",
      503,
    );
  }
  return {
    shopifyProductId,
    mockupImageUrl: mockup.toString(),
    canvasWidth,
    canvasHeight,
    printArea: { x, y, width, height },
    exportWidth,
    exportHeight,
    minimumUploadWidth: integerEnv("CUSTOM_HOUSE_DESIGNER_MIN_UPLOAD_WIDTH", 600, 64, 12000),
    minimumUploadHeight: integerEnv("CUSTOM_HOUSE_DESIGNER_MIN_UPLOAD_HEIGHT", 600, 64, 12000),
    maximumUploadBytes: integerEnv(
      "CUSTOM_HOUSE_DESIGNER_MAX_UPLOAD_BYTES",
      8 * 1024 * 1024,
      1024,
      20 * 1024 * 1024,
    ),
    allowedFileTypes: ["image/png", "image/jpeg", "image/webp"],
    allowedVariantIds,
  };
}

export function publicDesignerConfig(config: DesignerProductConfig) {
  return {
    shopifyProductId: config.shopifyProductId,
    mockupImageUrl: config.mockupImageUrl,
    canvasWidth: config.canvasWidth,
    canvasHeight: config.canvasHeight,
    printArea: config.printArea,
    exportWidth: config.exportWidth,
    exportHeight: config.exportHeight,
    minimumUploadWidth: config.minimumUploadWidth,
    minimumUploadHeight: config.minimumUploadHeight,
    maximumUploadBytes: config.maximumUploadBytes,
    allowedFileTypes: config.allowedFileTypes,
  };
}
