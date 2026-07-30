import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const snapshot = await db.orderDesignSnapshot.findFirst({
    where: {
      id: String(params.snapshotId || ""),
      shop: session.shop,
      printFilesStatus: "AVAILABLE",
      printFilesReference: { not: null },
    },
    select: { printFilesReference: true },
  });
  if (!snapshot?.printFilesReference) {
    throw new Response("Print files are not available.", { status: 404 });
  }
  let url: URL;
  try {
    url = new URL(snapshot.printFilesReference);
  } catch {
    throw new Response("Print files are not available.", { status: 404 });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Response("Print files are not available.", { status: 404 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
