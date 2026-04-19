import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acceptAiAuthoredBody,
  saveDraftBody,
  setDraftReview,
  syncDraftBodyFromAssistantText,
} from "./campaignCommands";
import { type Campaign, type DraftOutput, useCampaignStore } from "./campaignStore";

const envId = EnvironmentId.make("env-test");

function resetStore(): void {
  useCampaignStore.getState().setCampaigns([]);
}

function seedCampaign(draftOverrides: Partial<DraftOutput> = {}): {
  campaign: Campaign;
  draft: DraftOutput;
} {
  const threadId = ThreadId.make("thread-1");
  const draft: DraftOutput = {
    id: "draft-1",
    campaignId: "camp-1",
    channel: "linkedin",
    title: "Test — LinkedIn",
    body: "",
    bodyIsManuallyEdited: false,
    review: "none",
    progress: "generating",
    threadRef: { environmentId: envId, threadId },
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...draftOverrides,
  };
  const campaign: Campaign = {
    id: "camp-1",
    environmentId: envId,
    name: "Test campaign",
    brief: "",
    workingPrompt: "",
    selectedChannels: ["linkedin"],
    status: "in_progress",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    drafts: [draft],
  };
  useCampaignStore.getState().addCampaign(campaign);
  return { campaign, draft };
}

function getDraft(): DraftOutput {
  const campaign = useCampaignStore.getState().getCampaignById("camp-1");
  if (!campaign) throw new Error("seed campaign missing");
  const draft = campaign.drafts[0];
  if (!draft) throw new Error("seed draft missing");
  return draft;
}

beforeEach(resetStore);

describe("syncDraftBodyFromAssistantText", () => {
  it("writes streaming assistant text to the draft body and flips progress to 'generating'", () => {
    const { draft } = seedCampaign({ progress: "empty", body: "" });

    syncDraftBodyFromAssistantText({
      threadRef: draft.threadRef!,
      assistantText: "Partial output",
      streaming: true,
    });

    const after = getDraft();
    expect(after.body).toBe("Partial output");
    expect(after.progress).toBe("generating");
  });

  it("marks progress as 'draft' once streaming completes", () => {
    const { draft } = seedCampaign({ progress: "generating", body: "Partial" });

    syncDraftBodyFromAssistantText({
      threadRef: draft.threadRef!,
      assistantText: "Final body",
      streaming: false,
    });

    const after = getDraft();
    expect(after.body).toBe("Final body");
    expect(after.progress).toBe("draft");
  });

  it("never overwrites a manually edited body", () => {
    const { draft } = seedCampaign({
      progress: "generating",
      body: "My hand-written text",
      bodyIsManuallyEdited: true,
    });

    syncDraftBodyFromAssistantText({
      threadRef: draft.threadRef!,
      assistantText: "AI tried to overwrite this",
      streaming: false,
    });

    const after = getDraft();
    expect(after.body).toBe("My hand-written text");
    expect(after.bodyIsManuallyEdited).toBe(true);
    // But progress still advances — otherwise the "Generuji" spinner would
    // stay on forever after a regeneration finishes on a manually edited
    // draft.
    expect(after.progress).toBe("draft");
  });

  it("never clears the user-owned review state", () => {
    const { draft } = seedCampaign({ review: "approved", progress: "generating", body: "" });

    syncDraftBodyFromAssistantText({
      threadRef: draft.threadRef!,
      assistantText: "New AI text",
      streaming: false,
    });

    const after = getDraft();
    expect(after.review).toBe("approved");
    expect(after.body).toBe("New AI text");
    expect(after.progress).toBe("draft");
  });

  it("is a no-op when called for an unknown thread", () => {
    seedCampaign({ body: "keep me" });
    const before = getDraft();

    syncDraftBodyFromAssistantText({
      threadRef: { environmentId: envId, threadId: ThreadId.make("unknown-thread") },
      assistantText: "noise",
      streaming: false,
    });

    const after = getDraft();
    expect(after).toEqual(before);
  });
});

describe("setDraftReview", () => {
  it("writes only the review axis and leaves progress untouched", () => {
    seedCampaign({ review: "none", progress: "generating" });

    setDraftReview("camp-1", "draft-1", "approved");

    const after = getDraft();
    expect(after.review).toBe("approved");
    expect(after.progress).toBe("generating");
  });
});

describe("saveDraftBody", () => {
  it("marks the body as manually edited and optionally updates review", () => {
    seedCampaign({ review: "approved", body: "original", bodyIsManuallyEdited: false });

    saveDraftBody("camp-1", "draft-1", "edited body", { review: "none" });

    const after = getDraft();
    expect(after.body).toBe("edited body");
    expect(after.bodyIsManuallyEdited).toBe(true);
    expect(after.review).toBe("none");
  });

  it("preserves the current review state when options.review is not provided", () => {
    seedCampaign({ review: "pending_changes", body: "" });

    saveDraftBody("camp-1", "draft-1", "edited body");

    const after = getDraft();
    expect(after.body).toBe("edited body");
    expect(after.bodyIsManuallyEdited).toBe(true);
    expect(after.review).toBe("pending_changes");
  });
});

describe("acceptAiAuthoredBody", () => {
  it("clears the manual-edit flag so the sync hook can stream fresh output in", () => {
    seedCampaign({ body: "manual", bodyIsManuallyEdited: true });

    acceptAiAuthoredBody("camp-1", "draft-1");

    const after = getDraft();
    expect(after.bodyIsManuallyEdited).toBe(false);
    // Without a body argument, the existing body is preserved.
    expect(after.body).toBe("manual");
  });

  it("optionally snaps the body to a specific AI-authored snapshot", () => {
    seedCampaign({ body: "manual", bodyIsManuallyEdited: true });

    acceptAiAuthoredBody("camp-1", "draft-1", "assistant snapshot");

    const after = getDraft();
    expect(after.bodyIsManuallyEdited).toBe(false);
    expect(after.body).toBe("assistant snapshot");
  });
});
