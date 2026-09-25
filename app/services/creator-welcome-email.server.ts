import db from "../db.server.ts";
import { safeJson } from "./domain.ts";

type WelcomeEmailCreator = {
  id: string;
  status: string;
  displayName: string;
  emailSnapshot: string | null;
  welcomeEmailSentAt: Date | null;
};

type WelcomeEmailDatabase = {
  creator: {
    findFirst(args: unknown): Promise<WelcomeEmailCreator | null>;
    update(args: unknown): unknown;
  };
  shopConfig: {
    upsert(args: unknown): Promise<{
      creatorWelcomeEmailSubject: string;
      creatorWelcomeEmailBody: string;
    }>;
  };
  auditLog: {
    create(args: unknown): unknown;
  };
  $transaction(operations: unknown[]): Promise<unknown>;
};

type WelcomeEmailOptions = {
  database?: WelcomeEmailDatabase;
  fetcher?: typeof fetch;
  endpoint?: string;
  secret?: string;
};

type WelcomeEmailEnvironment = Record<string, string | undefined>;

export const CREATOR_WELCOME_EMAIL_ENVIRONMENT_KEYS = [
  "RESEND_API_KEY",
  "CREATOR_EMAIL_FROM",
  "CREATOR_WELCOME_EMAIL_WEBHOOK_URL",
  "CREATOR_WELCOME_EMAIL_WEBHOOK_SECRET",
] as const;

export const DEFAULT_CREATOR_WELCOME_SUBJECT = "Welcome to CustomHouse Creator";
export const DEFAULT_CREATOR_WELCOME_BODY = `Welcome to CustomHouse Creator, {{creator_name}}!

Next steps:
1. Open your Creator Dashboard: {{dashboard_url}}
2. Complete your profile and collection banner.
3. Create your first product by choosing one color and one printing method.

Tips & tricks: use a clear product title, preview every placement, and submit only artwork you have the rights to use.`;

export function cleanWelcomeEmailContent(subject: unknown, body: unknown) {
  const clean = (value: unknown, limit: number) =>
    Array.from(String(value || ""))
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
      })
      .join("")
      .trim()
      .slice(0, limit);
  const cleanSubject = clean(subject, 200);
  const cleanBody = clean(body, 10000);
  if (!cleanSubject || !cleanBody) throw new Error("Welcome email subject and body are required.");
  return { subject: cleanSubject, body: cleanBody };
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(creator_name|dashboard_url)\}\}/g, (_match, key: string) => values[key] || "");
}

function isHttpsEndpoint(value: unknown) {
  try {
    return new URL(String(value || "").trim()).protocol === "https:";
  } catch {
    return false;
  }
}

export function creatorWelcomeEmailTransportStatus(
  environment: WelcomeEmailEnvironment = process.env,
) {
  const missing = CREATOR_WELCOME_EMAIL_ENVIRONMENT_KEYS.filter((key) => {
    const value = String(environment[key] || "").trim();
    if (key === "CREATOR_WELCOME_EMAIL_WEBHOOK_URL") return !isHttpsEndpoint(value);
    return !value;
  });
  return { configured: missing.length === 0, missing };
}

export function creatorWelcomeEmailTransportConfigured(
  environment: WelcomeEmailEnvironment = process.env,
) {
  return creatorWelcomeEmailTransportStatus(environment).configured;
}

export function canSendCreatorWelcomeEmail(
  creator: Pick<WelcomeEmailCreator, "status" | "welcomeEmailSentAt">,
) {
  return creator.status === "APPROVED" && !creator.welcomeEmailSentAt;
}

export async function sendCreatorWelcomeEmail(
  shop: string,
  creatorId: string,
  options: WelcomeEmailOptions = {},
) {
  const database = options.database || (db as unknown as WelcomeEmailDatabase);
  const fetcher = options.fetcher || fetch;
  const creator = await database.creator.findFirst({ where: { id: creatorId, shop } });
  if (!creator || !canSendCreatorWelcomeEmail(creator)) {
    return { sent: false as const, reason: "not-eligible" as const };
  }
  const config = await database.shopConfig.upsert({ where: { shop }, update: {}, create: { shop } });
  const recipient = String(creator.emailSnapshot || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false as const, reason: "email-unavailable" as const };
  }
  const endpoint = String(
    options.endpoint ?? process.env.CREATOR_WELCOME_EMAIL_WEBHOOK_URL ?? "",
  ).trim();
  const secret = String(
    options.secret ?? process.env.CREATOR_WELCOME_EMAIL_WEBHOOK_SECRET ?? "",
  ).trim();
  if (!isHttpsEndpoint(endpoint) || !secret) {
    await database.auditLog.create({
      data: {
        shop,
        actorType: "SYSTEM",
        action: "creator.welcome_email.pending_configuration",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ recipientAvailable: true }),
      },
    });
    return { sent: false as const, reason: "transport-unconfigured" as const };
  }
  const values = { creator_name: creator.displayName, dashboard_url: `https://${shop}/pages/creator-dashboard` };
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        to: recipient,
        subject: renderTemplate(config.creatorWelcomeEmailSubject, values),
        text: renderTemplate(config.creatorWelcomeEmailBody, values),
        template: "creator-welcome",
        creatorId: creator.id,
      }),
    });
    if (!response.ok) throw new Error("Creator welcome email delivery failed.");
  } catch {
    await database.auditLog.create({
      data: {
        shop,
        actorType: "SYSTEM",
        action: "creator.welcome_email.delivery_failed",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ retryable: true }),
      },
    });
    return { sent: false as const, reason: "delivery-failed" as const };
  }
  const sentAt = new Date();
  await database.$transaction([
    database.creator.update({ where: { id: creator.id }, data: { welcomeEmailSentAt: sentAt } }),
    database.auditLog.create({
      data: {
        shop,
        actorType: "SYSTEM",
        action: "creator.welcome_email.sent",
        entityType: "Creator",
        entityId: creator.id,
        afterJson: safeJson({ sentAt }),
      },
    }),
  ]);
  return { sent: true as const, sentAt };
}
