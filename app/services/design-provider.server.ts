import { normalizeHttpsUrl } from "./domain";
export interface ManualDesignInput { baseProductId: string; baseVariantId?: string; designName: string; savedDesignUrl: string; inkybayDesignId?: string; previewUrl?: string; creatorMessage?: string }
export interface DesignProvider { readonly name: string; normalize(input: ManualDesignInput, allowedHosts: string[]): ManualDesignInput }
export class ManualInkyBayProvider implements DesignProvider {
  readonly name = "manual-inkybay";
  normalize(input: ManualDesignInput, allowedHosts: string[]): ManualDesignInput {
    const designName = input.designName.trim(); if (designName.length < 2 || designName.length > 100) throw new Error("Design name must be between 2 and 100 characters.");
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(input.baseProductId)) throw new Error("A valid Shopify product ID is required.");
    return { ...input, designName, savedDesignUrl: normalizeHttpsUrl(input.savedDesignUrl, allowedHosts), previewUrl: input.previewUrl ? normalizeHttpsUrl(input.previewUrl) : undefined };
  }
}
export class FutureInkyBayApiProvider implements DesignProvider { readonly name = "future-inkybay-api-disabled"; normalize(): never { throw new Error("InkyBay API mode is disabled until signed API documentation is configured."); } }
