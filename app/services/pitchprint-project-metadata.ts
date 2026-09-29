import { DomainError } from "./domain.ts";
import type { EmbroiderySubtype } from "./production-method-pricing.server.ts";

const MAX_SOURCE_BYTES = 500_000;
const MAX_PAGES = 20;
const MAX_OBJECTS = 500;
const MAX_DEPTH = 16;

export type PitchPrintArtworkFacts = {
  embroiderySubtype: EmbroiderySubtype;
  placements: string[];
  placementCount: number;
  objectCounts: { text: number; image: number };
  surfaces: Array<{ side: string; hasArtwork: boolean }>;
};

function invalidArtworkMetadata() {
  return new DomainError(
    "PITCHPRINT_ARTWORK_TYPE_UNRESOLVED",
    "The saved artwork type could not be determined. Please return to the editor and save the design again.",
    422,
  );
}

function parsedSource(source: unknown): Record<string, unknown> {
  let serialized: string;
  let parsed: unknown;
  try {
    const encoded = typeof source === "string" ? source : JSON.stringify(source);
    if (typeof encoded !== "string") throw invalidArtworkMetadata();
    serialized = encoded;
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_SOURCE_BYTES) {
      throw invalidArtworkMetadata();
    }
    parsed = typeof source === "string" ? JSON.parse(source) : source;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw invalidArtworkMetadata();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidArtworkMetadata();
  }
  return parsed as Record<string, unknown>;
}

function cleanSide(value: unknown, index: number) {
  const side = String(value || "").trim().slice(0, 80);
  return side || `Saved view ${index + 1}`;
}

function objectChildren(record: Record<string, unknown>) {
  for (const key of ["objects", "items", "elements", "layers", "children"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function objectKind(record: Record<string, unknown>) {
  return String(
    record.type ||
      record.kind ||
      record.objectType ||
      record.className ||
      record._type ||
      "",
  ).trim().toLowerCase();
}

function isPrintable(record: Record<string, unknown>) {
  return !(
    record.visible === false ||
    record.printable === false ||
    record.excludeFromPrint === true ||
    record.hidden === true ||
    record.isBlank === true
  );
}

function inspectObjects(
  values: unknown[],
  state: { text: number; image: number; unknown: number; visited: number },
  depth = 0,
) {
  if (depth > MAX_DEPTH) throw invalidArtworkMetadata();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      state.unknown += 1;
      continue;
    }
    state.visited += 1;
    if (state.visited > MAX_OBJECTS) throw invalidArtworkMetadata();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
      throw invalidArtworkMetadata();
    }
    if (!isPrintable(record)) continue;
    const children = objectChildren(record);
    const kind = objectKind(record);
    if (/text|textbox|i-text|itext|richtext/.test(kind)) {
      state.text += 1;
    } else if (/image|photo|logo|bitmap|raster|svg|vector/.test(kind)) {
      state.image += 1;
    } else if (children.length) {
      inspectObjects(children, state, depth + 1);
    } else if (!/^(group|canvas|page|surface|background|template)$/.test(kind)) {
      state.unknown += 1;
    }
  }
}

function sourcePages(source: Record<string, unknown>) {
  for (const key of ["pages", "canvases", "surfaces", "layouts"]) {
    if (Array.isArray(source[key])) return source[key] as unknown[];
  }
  return objectChildren(source).length ? [source] : [];
}

export function classifyPitchPrintProjectSource(source: unknown): PitchPrintArtworkFacts {
  const root = parsedSource(source);
  const pages = sourcePages(root);
  if (!pages.length || pages.length > MAX_PAGES) throw invalidArtworkMetadata();

  const totals = { text: 0, image: 0, unknown: 0, visited: 0 };
  const surfaces = pages.map((page, index) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw invalidArtworkMetadata();
    }
    const record = page as Record<string, unknown>;
    const before = totals.text + totals.image;
    inspectObjects(objectChildren(record), totals);
    return {
      side: cleanSide(
        record.name || record.label || record.title || record.side || record.id,
        index,
      ),
      hasArtwork: totals.text + totals.image > before,
    };
  });

  if (totals.unknown > 0 || totals.text + totals.image === 0) {
    throw invalidArtworkMetadata();
  }
  const placements = surfaces
    .filter((surface) => surface.hasArtwork)
    .map((surface) => surface.side);
  if (!placements.length) throw invalidArtworkMetadata();

  return {
    embroiderySubtype: totals.image > 0 ? "IMAGE_OR_LOGO" : "TEXT_ONLY",
    placements,
    placementCount: placements.length,
    objectCounts: { text: totals.text, image: totals.image },
    surfaces,
  };
}
