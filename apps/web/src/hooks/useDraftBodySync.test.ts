import {
  EnvironmentId,
  MessageId,
  type OrchestrationLatestTurn,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { computeDraftBodySync } from "./useDraftBodySync";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Thread,
} from "../types";

const envId = EnvironmentId.make("env-test");

function makeMessage(
  overrides: Partial<ChatMessage> & { id: MessageId; role: ChatMessage["role"] },
): ChatMessage {
  return {
    id: overrides.id,
    role: overrides.role,
    text: overrides.text ?? "",
    createdAt: "2026-04-01T00:00:00.000Z",
    streaming: overrides.streaming ?? false,
    attachments: [],
    turnId: overrides.turnId ?? null,
    completedAt: overrides.completedAt,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: envId,
    codexThreadId: null,
    projectId: ProjectId.make("project-1"),
    title: "Test thread",
    modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeTurn(overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-04-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  };
}

describe("computeDraftBodySync", () => {
  it("returns null when the thread has no latestTurn", () => {
    const result = computeDraftBodySync(makeThread());
    expect(result).toBeNull();
  });

  it("returns null while the turn has been requested but the assistant hasn't produced a message yet", () => {
    const result = computeDraftBodySync(
      makeThread({
        latestTurn: makeTurn({ state: "running", assistantMessageId: null }),
        messages: [
          makeMessage({ id: MessageId.make("m-user-2"), role: "user", text: "Please regenerate" }),
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it("ignores older assistant messages even when a newer user message is pending", () => {
    // Regression test for the bug where scanning messages from the tail
    // resurfaced the previous turn's assistant reply during regeneration.
    const oldAssistantId = MessageId.make("m-assistant-1");
    const result = computeDraftBodySync(
      makeThread({
        // latestTurn points at a NEW turn whose assistant hasn't spoken yet.
        latestTurn: makeTurn({
          turnId: TurnId.make("turn-2"),
          state: "running",
          assistantMessageId: null,
        }),
        messages: [
          makeMessage({ id: MessageId.make("m-user-1"), role: "user", text: "Initial" }),
          makeMessage({ id: oldAssistantId, role: "assistant", text: "Old draft body" }),
          makeMessage({ id: MessageId.make("m-user-2"), role: "user", text: "Please regenerate" }),
        ],
      }),
    );
    expect(result).toBeNull();
  });

  it("returns streaming text when the assistant is actively producing output", () => {
    const assistantId = MessageId.make("m-assistant-2");
    const result = computeDraftBodySync(
      makeThread({
        latestTurn: makeTurn({ state: "running", assistantMessageId: assistantId }),
        messages: [
          makeMessage({ id: MessageId.make("m-user-2"), role: "user", text: "Please regenerate" }),
          makeMessage({ id: assistantId, role: "assistant", text: "Partial…", streaming: true }),
        ],
      }),
    );
    expect(result).toEqual({ assistantText: "Partial…", streaming: true });
  });

  it("returns null for an empty streaming message (avoids flashing empty body)", () => {
    const assistantId = MessageId.make("m-assistant-2");
    const result = computeDraftBodySync(
      makeThread({
        latestTurn: makeTurn({ state: "running", assistantMessageId: assistantId }),
        messages: [makeMessage({ id: assistantId, role: "assistant", text: "", streaming: true })],
      }),
    );
    expect(result).toBeNull();
  });

  it("returns completed text with streaming=false when the turn finished", () => {
    const assistantId = MessageId.make("m-assistant-2");
    const result = computeDraftBodySync(
      makeThread({
        latestTurn: makeTurn({
          state: "completed",
          assistantMessageId: assistantId,
          completedAt: "2026-04-01T00:01:00.000Z",
        }),
        messages: [
          makeMessage({
            id: assistantId,
            role: "assistant",
            text: "Final body",
            streaming: false,
          }),
        ],
      }),
    );
    expect(result).toEqual({ assistantText: "Final body", streaming: false });
  });

  it("treats error/interrupted turns as non-streaming so progress can exit 'generating'", () => {
    const assistantId = MessageId.make("m-assistant-2");
    const result = computeDraftBodySync(
      makeThread({
        latestTurn: makeTurn({ state: "error", assistantMessageId: assistantId }),
        messages: [
          makeMessage({ id: assistantId, role: "assistant", text: "Partial", streaming: false }),
        ],
      }),
    );
    expect(result).toEqual({ assistantText: "Partial", streaming: false });
  });
});
