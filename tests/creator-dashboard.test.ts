import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboardState, resolveDashboardState } from "../extensions/customhouse-creator-storefront/assets/customhouse-dashboard.js";

test("logged-out dashboard state", () => {
  assert.deepEqual(resolveDashboardState({ state: "LOGGED_OUT" }), {
    state: "LOGGED_OUT",
    message: "Please sign in to access your creator dashboard.",
  });
});

test("missing creator becomes not-applied state", () => {
  assert.deepEqual(resolveDashboardState({ state: "NOT_APPLIED", creatorFound: false }), {
    state: "NOT_APPLIED",
    message: "No creator application was found.",
  });
});

test("dashboard exposes a safe synchronization conflict state", () => { assert.equal(resolveDashboardState({ state: "SYNC_CONFLICT" }).state, "SYNC_CONFLICT"); });

test("pending dashboard state", () => {
  const state = resolveDashboardState({ state: "PENDING", status: "PENDING" });
  assert.equal(state.state, "PENDING");
  assert.equal(state.message, "Your creator application is under review.");
});

test("approved dashboard preserves profile data", () => {
  const data = { state: "APPROVED", displayName: "Ari", status: "APPROVED", collectionUrl: "/collections/ari-designs", submissions: [{ designName: "Sky", status: "PENDING" }] };
  const view = resolveDashboardState(data);
  assert.equal(view.state, "APPROVED");
  assert.equal(view.data.displayName, "Ari");
  assert.equal(view.data.collectionUrl, "/collections/ari-designs");
  assert.equal(view.data.submissions.length, 1);
});

test("rejected dashboard state includes safe reason", () => {
  assert.equal(resolveDashboardState({ state: "REJECTED", rejectionReason: "Portfolio incomplete" }).message, "Your creator application was rejected: Portfolio incomplete");
});

test("suspended dashboard state includes safe reason", () => {
  assert.equal(resolveDashboardState({ state: "SUSPENDED", suspensionReason: "Review required" }).message, "Your creator account is suspended: Review required");
});

test("API failure emits error and always clears loading", async () => {
  const events: Array<{ state: string; loading: boolean }> = [];
  await loadDashboardState(async () => { throw new Error("private upstream error"); }, (event: { state: string; loading: boolean }) => events.push(event));
  assert.deepEqual(events.map((event) => event.state), ["LOADING", "API_ERROR", "LOADING_COMPLETE"]);
  assert.equal(events[0]?.loading, true);
  assert.equal(events.at(-1)?.loading, false);
});

test("successful response always clears loading", async () => {
  const events: Array<{ state: string; loading: boolean }> = [];
  await loadDashboardState(async () => ({ state: "PENDING" }), (event: { state: string; loading: boolean }) => events.push(event));
  assert.deepEqual(events.map((event) => event.state), ["LOADING", "PENDING", "LOADING_COMPLETE"]);
  assert.equal(events.at(-1)?.loading, false);
});
