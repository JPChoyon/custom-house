import type { LoaderFunctionArgs } from "react-router";
import { DomainError } from "../services/domain";
import { proxyContext } from "../services/proxy.server";
import { getZakekePublicConfiguration } from "../services/zakeke/zakeke-config.server";
import {
  zakekeDesignerHtml,
  zakekeUnavailableHtml,
} from "../services/zakeke/zakeke-designer-page.server";
import { createZakekeDesignerSession } from "../services/zakeke/zakeke-session.server";

const HTML_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self' https://portal.zakeke.com https://*.zakeke.com; script-src 'self' 'unsafe-inline' https://portal.zakeke.com https://*.zakeke.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://*.zakeke.com; frame-src https://*.zakeke.com",
};

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request, false);
    const url = new URL(request.url);
    const session = await createZakekeDesignerSession({
      shop,
      customerId,
      productId: url.searchParams.get("product_id") || "",
      variantId: url.searchParams.get("variant_id") || "",
      intent: url.searchParams.get("intent"),
      client,
    });
    return new Response(
      zakekeDesignerHtml({
        ...session,
        customizerScriptUrl:
          getZakekePublicConfiguration().customizerScriptUrl,
      }),
      { headers: HTML_HEADERS },
    );
  } catch (error) {
    const message =
      error instanceof DomainError
        ? error.message
        : "The customizer could not be opened. Please try again.";
    return new Response(zakekeUnavailableHtml(message), {
      status: error instanceof DomainError ? error.status : 500,
      headers: HTML_HEADERS,
    });
  }
}
