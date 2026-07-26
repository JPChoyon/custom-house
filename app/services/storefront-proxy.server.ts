import { DomainError } from "./domain.ts";

const SAFE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const;

export type VerifiedProxyContext = {
  shop: string;
  customerId: string | null;
};

export type ProxyAuthenticator = (
  request: Request,
) => Promise<VerifiedProxyContext>;

type ProxyRoute =
  | { kind: "base" }
  | { kind: "creators" }
  | { kind: "creator"; creatorHandle: string }
  | { kind: "design"; designSlug: string }
  | { kind: "designCart"; designId: string }
  | { kind: "notFound" };

function success(data: Record<string, unknown>, status = 200): Response {
  return Response.json(
    { success: true, ...data },
    { status, headers: SAFE_HEADERS },
  );
}

function failure(code: string, message: string, status: number): Response {
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers: SAFE_HEADERS },
  );
}

function safeSegment(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    throw new DomainError(
      "INVALID_PROXY_PATH",
      `The ${label} is invalid.`,
      400,
    );
  }
  if (
    !decoded ||
    decoded.length > 100 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(decoded)
  ) {
    throw new DomainError(
      "INVALID_PROXY_PATH",
      `The ${label} is invalid.`,
      400,
    );
  }
  return decoded;
}

export function parseProxyRoute(splat = ""): ProxyRoute {
  const parts = splat.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "base" };
  if (parts.length === 1 && parts[0] === "creators") {
    return { kind: "creators" };
  }
  if (parts.length === 2 && parts[0] === "creator") {
    return {
      kind: "creator",
      creatorHandle: safeSegment(parts[1], "creator handle"),
    };
  }
  if (parts.length === 2 && parts[0] === "design") {
    return {
      kind: "design",
      designSlug: safeSegment(parts[1], "design slug"),
    };
  }
  if (
    parts.length === 3 &&
    parts[0] === "design" &&
    parts[2] === "cart"
  ) {
    return {
      kind: "designCart",
      designId: safeSegment(parts[1], "design ID"),
    };
  }
  return { kind: "notFound" };
}

function isUnsignedBaseHealthRequest(request: Request, route: ProxyRoute) {
  if (route.kind !== "base" || request.method !== "GET") return false;
  const params = new URL(request.url).searchParams;
  return (
    !params.has("signature") &&
    !params.has("shop") &&
    !params.has("timestamp") &&
    !params.has("logged_in_customer_id") &&
    !params.has("path_prefix")
  );
}

async function safeJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new DomainError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Send a JSON request body.",
      415,
    );
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new DomainError("INVALID_JSON", "Send valid JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_JSON", "Expected a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export async function handleStorefrontProxy(
  request: Request,
  splat = "",
  authenticateProxy?: ProxyAuthenticator,
): Promise<Response> {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      return failure(
        "METHOD_NOT_ALLOWED",
        "This request method is not supported.",
        405,
      );
    }

    const route = parseProxyRoute(splat);
    if (isUnsignedBaseHealthRequest(request, route)) {
      return success({
        message: "Custom House Shopify App Proxy is working",
      });
    }

    if (!new URL(request.url).searchParams.get("signature")) {
      throw new DomainError(
        "MISSING_PROXY_SIGNATURE",
        "The storefront request could not be verified.",
        401,
      );
    }
    if (!authenticateProxy) {
      throw new DomainError(
        "PROXY_AUTHENTICATION_UNAVAILABLE",
        "The storefront request could not be verified.",
        503,
      );
    }
    const context = await authenticateProxy(request);
    const customer = context.customerId
      ? { loggedIn: true, customerId: context.customerId }
      : { loggedIn: false, customerId: null };

    switch (route.kind) {
      case "base":
        return success({
          message: "Custom House Shopify App Proxy is working",
          customer,
        });
      case "creators":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator listings only support GET requests.",
            405,
          );
        }
        return success({
          route: "creators",
          ready: false,
          message: "Creator storefront listings are not connected yet.",
          customer,
        });
      case "creator":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator profiles only support GET requests.",
            405,
          );
        }
        return success({
          route: "creator",
          creatorHandle: route.creatorHandle,
          ready: false,
          message: "Creator storefront profiles are not connected yet.",
          customer,
        });
      case "design":
        if (request.method !== "GET") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Creator designs only support GET requests.",
            405,
          );
        }
        return success({
          route: "design",
          designSlug: route.designSlug,
          ready: false,
          message: "Creator storefront designs are not connected yet.",
          customer,
        });
      case "designCart":
        if (request.method !== "POST") {
          return failure(
            "METHOD_NOT_ALLOWED",
            "Adding a creator design to cart requires POST.",
            405,
          );
        }
        await safeJsonBody(request);
        return failure(
          "DESIGN_CART_NOT_READY",
          "Creator design purchasing is not available yet.",
          501,
        );
      case "notFound":
        return failure(
          "PROXY_ROUTE_NOT_FOUND",
          "The requested storefront route was not found.",
          404,
        );
    }
  } catch (error) {
    if (error instanceof DomainError) {
      return failure(error.code, error.message, error.status);
    }
    if (error instanceof Response && [401, 403].includes(error.status)) {
      return failure(
        "INVALID_PROXY_SIGNATURE",
        "The storefront request could not be verified.",
        error.status,
      );
    }
    console.error("storefront_proxy_error", {
      route: new URL(request.url).pathname,
      category: "request_failed",
    });
    return failure(
      "INTERNAL_ERROR",
      "The storefront request could not be completed.",
      500,
    );
  }
}
