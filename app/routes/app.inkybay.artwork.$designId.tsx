import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { DomainError } from "../services/domain";
import { signPrivateProductionDownload } from "../services/inkybay/private-storage.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const design = await db.creatorDesign.findFirst({
    where: {
      id: params.designId || "",
      shop: session.shop,
      provider: "INKYBAY",
    },
    select: { productionArtworkKey: true },
  });
  if (!design?.productionArtworkKey) {
    throw new DomainError(
      "PRODUCTION_ARTWORK_NOT_FOUND",
      "The production artwork was not found.",
      404,
    );
  }
  return Response.redirect(
    await signPrivateProductionDownload(design.productionArtworkKey),
    302,
  );
}
