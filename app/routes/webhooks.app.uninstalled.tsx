import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.$transaction([
      db.orderDesignSnapshot.deleteMany({ where: { shop } }),
      db.zakekeOrderJob.deleteMany({ where: { shop } }),
      db.webhookDelivery.deleteMany({ where: { shop } }),
      db.designPurchase.deleteMany({ where: { shop } }),
      db.creatorDesign.deleteMany({ where: { shop } }),
      db.designSession.deleteMany({ where: { shop } }),
      db.globalProductMapping.deleteMany({ where: { shop } }),
      db.creatorApplication.deleteMany({ where: { shop } }),
      db.designSubmission.deleteMany({ where: { shop } }),
      db.creator.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
      db.shopConfig.deleteMany({ where: { shop } }),
      db.auditLog.deleteMany({ where: { shop } }),
    ]);
  }

  return new Response();
};
