export type CreatorProductionMetadataSnapshot = {
  version: 1;
  creatorProductId: string;
  pitchprintProjectId: string | null;
  pitchprintMasterProjectId: string | null;
  pitchprintDesignId: string | null;
  fixedColor: string;
  productionMethod: "EMBROIDERY" | "DTF" | "DTG" | null;
  embroiderySubtype: "TEXT_ONLY" | "IMAGE_OR_LOGO" | null;
  placementCount: number;
  placements: string[];
  previewSurfaces: Array<{
    side: string;
    url: string;
    hasArtwork: boolean;
  }>;
};

type CreatorProductMetadataSource = {
  id: string;
  pitchprintProjectId: string | null;
  pitchprintDesignId: string | null;
  designVariantSelectionsJson: string;
};

function cleanOptionalText(value: unknown, maxLength: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function setupFromJson(value: string) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function creatorProductionMetadataSnapshot(
  product: CreatorProductMetadataSource,
  orderProjectId: string | null,
): CreatorProductionMetadataSnapshot {
  const setup = setupFromJson(product.designVariantSelectionsJson);
  const productionMethod = ["EMBROIDERY", "DTF", "DTG"].includes(
    String(setup.productionMethod || ""),
  )
    ? (setup.productionMethod as CreatorProductionMetadataSnapshot["productionMethod"])
    : null;
  const embroiderySubtype =
    productionMethod === "EMBROIDERY" &&
    ["TEXT_ONLY", "IMAGE_OR_LOGO"].includes(String(setup.embroiderySubtype || ""))
      ? (setup.embroiderySubtype as CreatorProductionMetadataSnapshot["embroiderySubtype"])
      : null;
  const placementCount = Number(setup.placementCount);
  const placements = (Array.isArray(setup.placements) ? setup.placements : [])
    .map((placement) => cleanOptionalText(placement, 80))
    .filter((placement): placement is string => Boolean(placement))
    .slice(0, 20);
  const previewSurfaces = (
    Array.isArray(setup.previewSurfaces) ? setup.previewSurfaces : []
  )
    .map((surface) => {
      const record =
        surface && typeof surface === "object" && !Array.isArray(surface)
          ? (surface as Record<string, unknown>)
          : {};
      const side = cleanOptionalText(record.side, 80);
      const url = cleanOptionalText(record.url, 2048);
      return side && url?.startsWith("https://")
        ? { side, url, hasArtwork: record.hasArtwork === true }
        : null;
    })
    .filter(
      (surface): surface is CreatorProductionMetadataSnapshot["previewSurfaces"][number] =>
        Boolean(surface),
    )
    .slice(0, 10);

  return {
    version: 1,
    creatorProductId: product.id,
    pitchprintProjectId: cleanOptionalText(orderProjectId, 200),
    pitchprintMasterProjectId: cleanOptionalText(product.pitchprintProjectId, 200),
    pitchprintDesignId: cleanOptionalText(product.pitchprintDesignId, 200),
    fixedColor: cleanOptionalText(setup.fixedColor, 120) || "",
    productionMethod,
    embroiderySubtype,
    placementCount:
      Number.isSafeInteger(placementCount) && placementCount > 0 && placementCount <= 20
        ? placementCount
        : 0,
    placements,
    previewSurfaces,
  };
}

export function parseCreatorProductionMetadata(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CreatorProductionMetadataSnapshot)
      : null;
  } catch {
    return null;
  }
}
