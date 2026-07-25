export const REQUIRED_ENVIRONMENT_VARIABLES = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
] as const;

export type HealthResult = {
  status: "ok" | "error";
  app: "running";
  environment: "configured" | "missing";
  database: "connected" | "unavailable" | "not_checked";
};

export async function evaluateHealth(
  environment: Record<string, string | undefined>,
  pingDatabase: () => Promise<unknown>,
): Promise<{ status: number; body: HealthResult }> {
  const configured = REQUIRED_ENVIRONMENT_VARIABLES.every(
    (name) => Boolean(environment[name]?.trim()),
  );
  if (!configured) {
    return {
      status: 503,
      body: {
        status: "error",
        app: "running",
        environment: "missing",
        database: "not_checked",
      },
    };
  }
  try {
    await pingDatabase();
    return {
      status: 200,
      body: {
        status: "ok",
        app: "running",
        environment: "configured",
        database: "connected",
      },
    };
  } catch {
    return {
      status: 503,
      body: {
        status: "error",
        app: "running",
        environment: "configured",
        database: "unavailable",
      },
    };
  }
}
