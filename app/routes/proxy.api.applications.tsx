import type { ActionFunctionArgs } from "react-router";
import { DomainError } from "../services/domain";
import { apiError, proxyContext } from "../services/proxy.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    await proxyContext(request);
    throw new DomainError("HELIUM_FORM_REQUIRED", "Creator applications are submitted through the Helium Customer Fields form.", 410);
  } catch (error) { return apiError(error); }
}
