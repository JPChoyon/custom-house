import { ZakekeClient } from "./zakeke-client.server.ts";
import type {
  ZakekeDesign,
  ZakekeDesignItems,
  ZakekeIdentity,
  ZakekeOutputFiles,
} from "./zakeke-types.ts";

function segment(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/.test(value)) {
    throw new TypeError("Invalid Zakeke design identifier.");
  }
  return encodeURIComponent(value);
}

export class ZakekeDesignService {
  private readonly client: ZakekeClient;

  constructor(client = new ZakekeClient()) {
    this.client = client;
  }

  getDesign(
    designId: string,
    quantity = 1,
    identity: ZakekeIdentity = {},
  ) {
    const safeQuantity = Number.isInteger(quantity)
      ? Math.min(1000, Math.max(1, quantity))
      : 1;
    return this.client.requestJson<ZakekeDesign>(
      `/v3/designs/${segment(designId)}/${safeQuantity}`,
      {
        operation: "design_get",
        identity,
        retryable: true,
      },
    );
  }

  duplicateDesign(designId: string, identity: ZakekeIdentity = {}) {
    return this.client.requestJson<{ id: string }>(
      `/v2/designs/${segment(designId)}`,
      {
        method: "POST",
        operation: "design_duplicate",
        identity,
        retryable: false,
      },
    );
  }

  getDesignItems(designId: string, identity: ZakekeIdentity = {}) {
    return this.client.requestJson<ZakekeDesignItems>(
      `/v1/designs/${segment(designId)}/items`,
      {
        operation: "design_items",
        identity,
        retryable: true,
      },
    );
  }

  getOutputFiles(designId: string, identity: ZakekeIdentity = {}) {
    return this.client.requestJson<ZakekeOutputFiles>(
      `/v1/designs/${segment(designId)}/outputfiles/zip`,
      {
        operation: "design_output_files",
        identity,
        retryable: true,
      },
    );
  }
}
