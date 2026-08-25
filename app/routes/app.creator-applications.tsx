import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export async function loader({}: LoaderFunctionArgs) {
  return redirect("/app/creators");
}

export async function action({}: ActionFunctionArgs) {
  return redirect("/app/creators");
}
