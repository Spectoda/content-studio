import { describe, expect, it } from "vitest";

import {
  deriveDraftStatus,
  type DraftOutput,
  type LegacyDraftOutput,
  migrateDraft,
} from "./campaignStore";

function baseDraft(overrides: Partial<LegacyDraftOutput> = {}): LegacyDraftOutput {
  return {
    id: "draft-1",
    campaignId: "camp-1",
    channel: "linkedin",
    title: "Test",
    body: "",
    bodyIsManuallyEdited: false,
    threadRef: null,
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  } as LegacyDraftOutput;
}

describe("migrateDraft", () => {
  it("passes through drafts already on the new schema", () => {
    const draft = baseDraft({ review: "none", progress: "draft" });
    const migrated = migrateDraft(draft);
    expect(migrated.review).toBe("none");
    expect(migrated.progress).toBe("draft");
    expect(migrated).not.toHaveProperty("status");
  });

  it("maps legacy status='approved' to review='approved', progress='draft'", () => {
    const migrated = migrateDraft(baseDraft({ status: "approved" }));
    expect(migrated.review).toBe("approved");
    expect(migrated.progress).toBe("draft");
  });

  it("maps legacy status='review' to review='pending_changes'", () => {
    const migrated = migrateDraft(baseDraft({ status: "review" }));
    expect(migrated.review).toBe("pending_changes");
    expect(migrated.progress).toBe("draft");
  });

  it("maps legacy status='generating' to progress='generating'", () => {
    const migrated = migrateDraft(baseDraft({ status: "generating" }));
    expect(migrated.review).toBe("none");
    expect(migrated.progress).toBe("generating");
  });

  it("maps legacy status='empty' to progress='empty'", () => {
    const migrated = migrateDraft(baseDraft({ status: "empty" }));
    expect(migrated.review).toBe("none");
    expect(migrated.progress).toBe("empty");
  });

  it("treats a missing status field as empty/none (defensive default)", () => {
    // Drafts persisted before the `status` field existed at all wouldn't
    // even carry the property; we still need sensible defaults.
    const migrated = migrateDraft(baseDraft());
    expect(migrated.review).toBe("none");
    expect(migrated.progress).toBe("empty");
  });

  it("drops the legacy status field on the migrated draft", () => {
    const migrated = migrateDraft(baseDraft({ status: "approved" })) as DraftOutput & {
      status?: unknown;
    };
    expect(migrated.status).toBeUndefined();
  });
});

describe("deriveDraftStatus", () => {
  it("promotes review='approved' over any progress state", () => {
    expect(deriveDraftStatus({ review: "approved", progress: "generating" })).toBe("approved");
  });

  it("promotes review='pending_changes' to the 'review' status", () => {
    expect(deriveDraftStatus({ review: "pending_changes", progress: "draft" })).toBe("review");
  });

  it("returns the raw progress when review is 'none'", () => {
    expect(deriveDraftStatus({ review: "none", progress: "generating" })).toBe("generating");
    expect(deriveDraftStatus({ review: "none", progress: "draft" })).toBe("draft");
    expect(deriveDraftStatus({ review: "none", progress: "empty" })).toBe("empty");
  });
});
