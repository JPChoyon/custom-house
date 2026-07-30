import { DomainError } from "../domain.ts";
import type {
  ZakekeVariantMapping,
  ZakekeVariantMappingDocument,
} from "./zakeke-types.ts";

function safeAttributes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 20) return null;
  const attributes: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      !/^[A-Za-z0-9_.-]{1,80}$/.test(key) ||
      typeof item !== "string" ||
      !item.trim() ||
      item.length > 200
    ) {
      return null;
    }
    attributes[key] = item.trim();
  }
  return attributes;
}

export function parseVariantMapping(
  value: string,
): ZakekeVariantMappingDocument {
  if (value.length > 64_000) {
    throw new DomainError(
      "ZAKEKE_MAPPING_INVALID",
      "The Zakeke variant mapping is too large.",
      422,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError(
      "ZAKEKE_MAPPING_INVALID",
      "Enter valid Zakeke variant mapping JSON.",
      422,
    );
  }
  const variants =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as { variants?: unknown }).variants)
      ? (parsed as { variants: unknown[] }).variants
      : null;
  if (!variants || variants.length < 1 || variants.length > 100) {
    throw new DomainError(
      "ZAKEKE_MAPPING_INVALID",
      "Map between one and 100 Shopify variants.",
      422,
    );
  }
  const seen = new Set<string>();
  const normalized: ZakekeVariantMapping[] = variants.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainError(
        "ZAKEKE_MAPPING_INVALID",
        "Each Zakeke variant mapping must be an object.",
        422,
      );
    }
    const row = entry as Record<string, unknown>;
    const shopifyVariantId =
      typeof row.shopifyVariantId === "string"
        ? row.shopifyVariantId.trim()
        : "";
    const sku = typeof row.sku === "string" ? row.sku.trim() : "";
    const attributes = safeAttributes(row.attributes);
    if (
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(shopifyVariantId) ||
      !sku ||
      sku.length > 255 ||
      !attributes ||
      seen.has(shopifyVariantId)
    ) {
      throw new DomainError(
        "ZAKEKE_MAPPING_INVALID",
        "The Zakeke variant mapping contains an invalid or duplicate row.",
        422,
      );
    }
    seen.add(shopifyVariantId);
    return {
      shopifyVariantId,
      sku,
      attributes,
      enabled: row.enabled !== false,
    };
  });
  return { variants: normalized };
}
