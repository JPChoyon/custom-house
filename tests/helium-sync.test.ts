import assert from "node:assert/strict";
import test from "node:test";
import type { Creator } from "@prisma/client";
import {
  creatorStatusFromTags,
  hasConflictingCreatorTags,
  loadWithLazySync,
  normalizeCustomerGid,
  planHeliumSync,
} from "../app/services/helium-sync.ts";

function creator(overrides: Partial<Creator> = {}): Creator {
  return {
    id: "creator-1",
    shop: "test.myshopify.com",
    customerId: normalizeCustomerGid("1"),
    displayName: "Creator 1",
    handle: "creator-1",
    bio: null,
    portfolioUrl: null,
    profileImageUrl: null,
    socialLinksJson: "[]",
    legalName: null,
    country: null,
    city: null,
    applicationSource: "CUSTOM_APP",
    status: "PENDING",
    collectionId: null,
    creatorProfileMetaobjectId: null,
    approvedAt: null,
    rejectedAt: null,
    suspendedAt: null,
    rejectionReason: null,
    suspensionReason: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

test("imports a Helium pending applicant", () => {
  const plan = planHeliumSync(null, {
    customerId: "1",
    tags: ["creator-applicant", "creator-pending"],
    fields: { displayName: "Ada" },
  });
  assert.equal(plan.action, "CREATE");
  assert.equal(plan.status, "PENDING");
  assert.equal(plan.data.displayName, "Ada");
});

test("imports an approved creator", () => {
  const plan = planHeliumSync(null, {
    customerId: "2",
    tags: ["creator-approved"],
  });
  assert.equal(plan.action, "CREATE");
  assert.equal(plan.status, "APPROVED");
});

test("duplicate webhook delivery becomes a skip", () => {
  assert.equal(
    planHeliumSync(creator(), { customerId: "1", tags: ["creator-pending"] })
      .action,
    "SKIP",
  );
});

test("conflicting tags choose the most restrictive status", () => {
  assert.equal(
    hasConflictingCreatorTags(["creator-approved", "creator-suspended"]),
    true,
  );
  assert.equal(
    creatorStatusFromTags(["creator-approved", "creator-suspended"]),
    "SUSPENDED",
  );
  assert.equal(
    creatorStatusFromTags(["creator-pending", "creator-rejected"]),
    "REJECTED",
  );
});

test("status sync updates undecided creators but preserves app decisions", () => {
  assert.equal(
    planHeliumSync(creator(), { customerId: "1", tags: ["creator-approved"] })
      .data.status,
    "APPROVED",
  );
  assert.equal(
    planHeliumSync(creator({ status: "APPROVED", approvedAt: new Date() }), {
      customerId: "1",
      tags: ["creator-rejected"],
    }).action,
    "SKIP",
  );
});

test("dashboard performs one lazy synchronization then reloads", async () => {
  let found = false;
  let syncs = 0;
  const result = await loadWithLazySync(
    async () => ({ creatorFound: found, state: found ? "PENDING" : "MISSING" }),
    async () => {
      syncs++;
      found = true;
    },
  );
  assert.equal(syncs, 1);
  assert.equal(result.creatorFound, true);
  assert.equal(result.state, "PENDING");
});

test("dashboard does not lazy sync an existing creator", async () => {
  let syncs = 0;
  await loadWithLazySync(
    async () => ({ creatorFound: true }),
    async () => {
      syncs++;
    },
  );
  assert.equal(syncs, 0);
});
