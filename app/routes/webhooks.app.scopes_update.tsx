import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { runtimeEnvironment, sanitizedPreviewSkip } from "../services/environment-safety.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    if (runtimeEnvironment() !== "production") {
        sanitizedPreviewSkip(shop, String(topic), "PREVIEW_SCOPE_UPDATE_DISABLED");
        return new Response();
    }

    const current = payload.current as string[];
    if (session) {
        await db.session.update({   
            where: {
                id: session.id
            },
            data: {
                scope: current.toString(),
            },
        });
    }
    return new Response();
};
