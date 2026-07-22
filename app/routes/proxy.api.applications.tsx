import type { ActionFunctionArgs } from "react-router";
import { createApplication } from "../services/creator.server";
import { apiData, apiError, jsonBody, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { shop, customerId, client } = await proxyContext(request);
    enforceRateLimit(`${shop}:${customerId}:application`, 5, 60 * 60 * 1000);
    const body = await jsonBody(request);
    const socialLinks = Array.isArray(body.socialLinks) ? body.socialLinks.map(String) : [];
    const result = await createApplication(shop, customerId!, {
      legalName: String(body.legalName ?? ""), displayName: String(body.displayName ?? ""), country: String(body.country ?? ""), city: String(body.city ?? ""), bio: String(body.bio ?? ""), portfolioUrl: body.portfolioUrl ? String(body.portfolioUrl) : undefined, socialLinks, profileImageUrl: body.profileImageUrl ? String(body.profileImageUrl) : undefined, message: body.message ? String(body.message) : undefined, termsAccepted: body.termsAccepted === true,
    }, client);
    return apiData({ applicationId: result.application.id, status: "PENDING" }, 201);
  } catch (error) { return apiError(error); }
}
