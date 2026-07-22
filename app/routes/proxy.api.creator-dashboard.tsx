import type { LoaderFunctionArgs } from "react-router";
import { creatorDashboard } from "../services/submission.server";
import { apiData, apiError, proxyContext } from "../services/proxy.server";
import { enforceRateLimit } from "../services/rate-limit.server";
import { lazySyncCreator, loadWithLazySync } from "../services/helium-sync.server";

type DashboardStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | "APPLICATION_NOT_SUBMITTED";

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
    diagnostic({
      shop,
      customerIdExists: true,
      creatorFound: dashboard.creatorFound,
      creatorStatus: dashboard.state,
    });
    return apiData({ loggedIn: true, ...dashboard });
  } catch (error) {
    diagnostic({ shop, customerIdExists, creatorFound: false, creatorStatus: null });
    return apiError(error);
  }
}
