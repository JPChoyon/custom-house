import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  processZakekeOrderJob,
  queueZakekeOrder,
} from "../services/zakeke/zakeke-order-processing.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload, webhookId, topic } =
    await authenticate.webhook(request);
  const queued = await queueZakekeOrder({
    shop,
    webhookId,
    topic: String(topic),
    payload,
  });
  if (queued.jobId) {
    try {
      const job = await processZakekeOrderJob(queued.jobId);
      if (queued.deliveryId && job?.status === "REGISTERED") {
        await db.webhookDelivery.update({
          where: { id: queued.deliveryId },
          data: { status: "COMPLETED", processedAt: new Date() },
        });
      } else if (queued.deliveryId) {
        await db.webhookDelivery.update({
          where: { id: queued.deliveryId },
          data: {
            status: "FAILED",
            lastErrorCode: "ZAKEKE_ORDER_REGISTRATION_PENDING",
          },
        });
      }
    } catch {
      // The database-backed job remains retryable from the admin dashboard.
      if (queued.deliveryId) {
        await db.webhookDelivery.update({
          where: { id: queued.deliveryId },
          data: {
            status: "FAILED",
            lastErrorCode: "ZAKEKE_ORDER_REGISTRATION_PENDING",
          },
        });
      }
    }
  }
  return new Response();
}
