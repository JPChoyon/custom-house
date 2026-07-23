import type { LoaderFunctionArgs } from "react-router";
import { creatorDashboard } from "../services/submission.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import {
  lazySyncCreator,
  loadWithLazySync,
  normalizeCustomerGid,
} from "../services/helium-sync.server";

type DashboardStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | "NOT_APPLIED" | "SYNC_CONFLICT";

async function presentation(
  client: {
    request<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  },
  customerId: string,
  profileImageUrl?: string | null,
) {
  const result = await client.request<{
    customer: {
      firstName: string | null;
      lastName: string | null;
    } | null;
    profileImage: {
      image?: { url: string } | null;
    } | null;
  }>(
    `#graphql query CreatorPresentation($customerId: ID!, $profileImageId: ID!) {
      customer(id: $customerId) { firstName lastName }
      profileImage: node(id: $profileImageId) {
        ... on MediaImage { image { url } }
      }
    }`,
    {
      customerId,
      profileImageId: profileImageUrl?.startsWith("gid://")
        ? profileImageUrl
        : customerId,
    },
  );
  return {
    legalName: [
      result.customer?.firstName,
      result.customer?.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim(),
    profileImageUrl:
      result.profileImage?.image?.url ||
      (profileImageUrl?.startsWith("https://") ? profileImageUrl : null),
  };
}

function diagnostic(details: {
  shop: string;
  customerIdExists: boolean;
  creatorFound: boolean;
  creatorStatus: DashboardStatus | null;
}) {
  console.info("creator_dashboard_lookup", details);
}

export async function loader({ request }: LoaderFunctionArgs) {
  let shop = "unknown";
  let customerIdExists = false;
  try {
    // appProxy verifies Shopify's signature before signed query parameters are used.
    const context = await proxyContext(request, false);
    shop = context.shop;
    customerIdExists = Boolean(context.customerId);

    if (!context.customerId) {
      diagnostic({ shop, customerIdExists: false, creatorFound: false, creatorStatus: null });
      return apiData({ state: "LOGGED_OUT", loggedIn: false });
    }

    enforceRateLimit(`${shop}:${context.customerId}:dashboard`);
    const dashboard = await loadWithLazySync(
      () => creatorDashboard(shop, context.customerId!),
      () => lazySyncCreator(shop, context.customerId!, context.client),
    );
    const live = dashboard.creatorFound
      ? await presentation(
          context.client,
          normalizeCustomerGid(context.customerId),
          dashboard.profileImageUrl,
        )
      : null;
    diagnostic({
      shop,
      customerIdExists: true,
      creatorFound: dashboard.creatorFound,
      creatorStatus: dashboard.state,
    });
    return apiData({
      loggedIn: true,
      ...dashboard,
      legalName: live?.legalName || dashboard.displayName,
      displayName: live?.legalName || dashboard.displayName,
      profileImageUrl:
        live?.profileImageUrl || dashboard.profileImageUrl || null,
    });
  } catch (error) {
    diagnostic({ shop, customerIdExists, creatorFound: false, creatorStatus: null });
    return apiError(error);
  }
}
