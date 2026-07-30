import { DomainError } from "../domain.ts";

const PUBLIC_MESSAGES: Record<string, string> = {
  ZAKEKE_NOT_CONFIGURED:
    "Product customization is not configured. Contact the store administrator.",
  ZAKEKE_UNAVAILABLE:
    "Product customization is temporarily unavailable. Please try again.",
  ZAKEKE_UNAUTHORIZED:
    "The customization service could not be authorized.",
  ZAKEKE_RATE_LIMITED:
    "The customization service is busy. Please try again shortly.",
  ZAKEKE_DESIGN_NOT_FOUND:
    "The selected design could not be found.",
  ZAKEKE_DESIGN_DUPLICATION_FAILED:
    "We could not prepare this design for purchase. Please try again.",
  ZAKEKE_ORDER_REGISTRATION_FAILED:
    "The customized order is waiting to be registered. An administrator can retry it.",
};

export class ZakekeError extends DomainError {
  readonly referenceId: string;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    referenceId: string;
    status?: number;
    retryable?: boolean;
    message?: string;
  }) {
    super(
      input.code,
      input.message ||
        PUBLIC_MESSAGES[input.code] ||
        "The customization request could not be completed.",
      input.status ?? 502,
    );
    this.referenceId = input.referenceId;
    this.retryable = input.retryable ?? false;
    this.name = "ZakekeError";
  }
}

export function zakekeErrorCode(status: number, operation: string) {
  if (status === 401 || status === 403) return "ZAKEKE_UNAUTHORIZED";
  if (status === 404 && operation.startsWith("design")) {
    return "ZAKEKE_DESIGN_NOT_FOUND";
  }
  if (status === 429) return "ZAKEKE_RATE_LIMITED";
  if (operation === "design_duplicate") {
    return "ZAKEKE_DESIGN_DUPLICATION_FAILED";
  }
  if (operation === "order_register") {
    return "ZAKEKE_ORDER_REGISTRATION_FAILED";
  }
  return "ZAKEKE_UNAVAILABLE";
}
