import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { normalizeCustomerGid } from "../services/helium-sync.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);
  const customerId = normalizeCustomerGid(
    (payload as { customer?: { id?: number | string } }).customer?.id ?? "",
  );
  const creator = await db.creator.findUnique({
    where: { shop_customerId: { shop, customerId } },
  });
  await db.$transaction([
    ...(creator
      ? [
          db.creatorDesign.deleteMany({ where: { creatorId: creator.id } }),
          db.creatorApplication.deleteMany({ where: { creatorId: creator.id } }),
          db.designSubmission.deleteMany({ where: { creatorId: creator.id } }),
        ]
      : []),
    db.designSession.deleteMany({ where: { shop, customerId } }),
    db.auditLog.deleteMany({ where: { shop, actorId: customerId } }),
    ...(creator
      ? [db.creator.delete({ where: { id: creator.id } })]
      : []),
  ]);
  return new Response();
}
