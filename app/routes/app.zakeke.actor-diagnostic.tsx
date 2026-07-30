import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { DomainError } from "../services/domain";
import { resolveStorefrontActor } from "../services/storefront-actor.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  if (process.env.ZAKEKE_ADMIN_DIAGNOSTICS_ENABLED !== "true") {
    throw new Response("Not found", { status: 404 });
  }
  const rawCustomerId =
    new URL(request.url).searchParams.get("customer_id");
  if (!rawCustomerId) {
    throw new DomainError(
      "CUSTOMER_ID_REQUIRED",
      "Enter a Shopify customer ID.",
      422,
    );
  }
  const actor = await resolveStorefrontActor(
    session.shop,
    rawCustomerId,
  );
  return Response.json(
    {
      shop: actor.shop,
      customerId: actor.customerId,
      creatorId: actor.creatorId,
      role: actor.role,
      creatorStatus: actor.creatorStatus,
      rawCreatorStatus: actor.rawCreatorStatus,
      normalizedCreatorStatus: actor.normalizedCreatorStatus,
      isCreator: actor.isCreator,
      isApprovedCreator: actor.isApprovedCreator,
      isSuspendedCreator: actor.isSuspendedCreator,
      isSuspended: actor.isSuspended,
      authorizedDesignerModes: actor.authorizedDesignerModes,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
