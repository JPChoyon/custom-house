export type ZakekeAccessType = "C2S" | "S2S";

export type ZakekeIdentity = {
  visitorCode?: string;
  customerCode?: string;
};

export type ZakekeToken = {
  accessToken: string;
  tokenType: "Bearer";
  accessType: ZakekeAccessType;
  expiresAt: number;
};

export type ZakekePreviewFile = {
  url: string;
  sideName?: string;
};

export type ZakekeDesign = {
  designID: string;
  compositionID?: string;
  name?: string;
  modelCode: string;
  modelID?: number;
  previewimageurl?: string;
  customerCode?: string;
  visitorCode?: string;
  previewFiles?: ZakekePreviewFile[];
  extraOptions?: Array<{
    name: string;
    value?: string | null;
    price?: number;
    metadata?: Record<string, unknown>;
  }>;
  minQuantity?: number | null;
  quantityStep?: number | null;
  quantityPackages?: number[] | null;
  quantityRuleType?: "product" | "variant" | null;
};

export type ZakekeDesignItem = {
  json?: string;
  name?: string;
  previewImageUrl?: string;
  sourceImageUrl?: string;
  code?: string;
  imageName?: string;
  text?: string;
  fontFamily?: string;
};

export type ZakekeDesignItems = {
  variant?: {
    name?: string;
    code?: string;
    sides?: Array<{
      name?: string;
      sidePrintTypeName?: string;
      areas?: Array<{
        name?: string;
        items?: ZakekeDesignItem[];
      }>;
    }>;
  };
};

export type ZakekeOutputFiles = {
  url: string;
};

export type RegisterZakekeOrderDetail = {
  orderDetailCode: string;
  sku: string;
  designID: string;
  modelUnitPrice: number;
  designUnitPrice: number;
  quantity: number;
  designModificationID?: string;
};

export type RegisterZakekeOrderInput = {
  orderCode: string;
  orderDate: string;
  sessionID: string;
  total: number;
  details: RegisterZakekeOrderDetail[];
};

export type RegisterZakekeOrderResult = Record<string, unknown>;

export type ZakekeVariantMapping = {
  shopifyVariantId: string;
  sku: string;
  attributes: Record<string, string>;
  enabled?: boolean;
};

export type ZakekeVariantMappingDocument = {
  variants: ZakekeVariantMapping[];
};
