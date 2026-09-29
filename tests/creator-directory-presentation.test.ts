import assert from "node:assert/strict";
import test from "node:test";
import { creatorRowPresentation } from "../app/components/creator-directory-presentation.ts";

test("pending creator rows use a review-first layout with one overflow menu", () => {
  assert.deepEqual(creatorRowPresentation("PENDING"), {
    rowClassName: "creator-row--pending",
    actionGroupClassName: "creator-action-group creator-action-group--pending",
    primaryActionLabel: "Review",
    consolidatePendingMenus: true,
  });
});

test("non-pending creator rows retain the standard directory layout", () => {
  assert.deepEqual(creatorRowPresentation("APPROVED"), {
    rowClassName: undefined,
    actionGroupClassName: "creator-action-group",
    primaryActionLabel: "View",
    consolidatePendingMenus: false,
  });
});
