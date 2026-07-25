import assert from "node:assert/strict";
import test from "node:test";
import config from "../react-router.config.ts";
import {
  evaluateHealth,
  REQUIRED_ENVIRONMENT_VARIABLES,
} from "../app/services/health.server.ts";
import {
  correlationId,
  observeAuthentication,
} from "../app/services/observability.server.ts";

const configuredEnvironment = Object.fromEntries(
  REQUIRED_ENVIRONMENT_VARIABLES.map((name) => [name, "configured"]),
);

test("Vercel React Router preset keeps SSR enabled", () => {
  assert.equal(config.ssr, true);
  assert.equal(config.presets?.length, 1);
});

test("health succeeds only after a database query succeeds", async () => {
  let queried = false;
  const result = await evaluateHealth(configuredEnvironment, async () => {
    queried = true;
    return [{ "?column?": 1 }];
  });
  assert.equal(queried, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    status: "ok",
    app: "running",
    environment: "configured",
    database: "connected",
  });
});

test("health returns non-200 when Neon is unavailable", async () => {
  const result = await evaluateHealth(configuredEnvironment, async () => {
    throw new Error("database unavailable");
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.database, "unavailable");
});

test("health reports missing configuration without exposing values", async () => {
  const result = await evaluateHealth({}, async () => {
    throw new Error("must not run");
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    status: "error",
    app: "running",
    environment: "missing",
    database: "not_checked",
  });
  assert.equal(JSON.stringify(result).includes("configured"), false);
});

test("authentication diagnostics preserve Shopify redirects and errors", async () => {
  const redirect = new Response(null, {
    status: 302,
    headers: { Location: "https://example.invalid/auth" },
  });
  await assert.rejects(
    observeAuthentication(
      "admin_authentication",
      new Request("https://app.example.invalid/app"),
      async () => {
        throw redirect;
      },
    ),
    (error) => error === redirect,
  );
});

test("correlation IDs accept safe request IDs and reject unsafe values", () => {
  assert.equal(
    correlationId(
      new Request("https://app.example.invalid", {
        headers: { "x-request-id": "request-12345" },
      }),
    ),
    "request-12345",
  );
  assert.notEqual(
    correlationId(
      new Request("https://app.example.invalid", {
        headers: { "x-request-id": "bad value with spaces" },
      }),
    ),
    "bad value with spaces",
  );
});
