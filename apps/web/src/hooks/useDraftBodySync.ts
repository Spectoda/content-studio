/**
 * Keep a campaign draft's body in sync with the latest assistant message on
 * its backing thread. When the user manually edits the body, that override
 * wins and no further sync happens until they explicitly regenerate.
 *
 * Also retains a WebSocket subscription to the backing thread while the hook
 * is mounted — without it the zustand store never receives assistant deltas,
 * so the draft would stay "Generating" forever even after Codex has finished
 * responding. Subscription retention is ref-counted inside the environment
 * runtime service so mounting this hook on many draft cards at once is safe.
 */

import { useEffect, useMemo } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { syncDraftBodyFromAssistantText } from "../campaignCommands";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import type { Thread } from "../types";

/**
 * Pure sync decision — factored out of the React hook so it can be unit
 * tested without mounting components. Returns the arguments that the hook
 * would pass to `syncDraftBodyFromAssistantText`, or `null` when no sync
 * should happen for this observed thread snapshot.
 *
 * The decision uses `thread.latestTurn` as the authoritative handle for
 * "current turn's assistant reply". Scanning messages for the last
 * assistant used to be the approach here, but that left a race window
 * during regeneration where the *previous* turn's answer was briefly
 * visible and got re-synced into the draft — undoing the reset. Using
 * latestTurn.assistantMessageId eliminates that window entirely.
 */
export function computeDraftBodySync(
  thread: Pick<Thread, "id" | "messages" | "latestTurn">,
): { assistantText: string; streaming: boolean } | null {
  const latestTurn = thread.latestTurn;
  if (!latestTurn) return null;
  const assistantMessageId = latestTurn.assistantMessageId;
  if (!assistantMessageId) {
    // Turn requested but the assistant hasn't materialised a message yet.
    return null;
  }
  const assistantMessage = thread.messages.find((entry) => entry.id === assistantMessageId);
  if (!assistantMessage) return null;

  const streaming = latestTurn.state === "running";
  if (assistantMessage.text.trim().length === 0 && streaming) return null;

  return { assistantText: assistantMessage.text, streaming };
}

export function useDraftBodySync(threadRef: ScopedThreadRef | null | undefined): void {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const selector = useMemo(
    () => createThreadSelectorByRef(environmentId && threadId ? { environmentId, threadId } : null),
    [environmentId, threadId],
  );
  const thread = useStore(selector);

  useEffect(() => {
    if (!environmentId || !threadId) return;
    return retainThreadDetailSubscription(environmentId, threadId);
  }, [environmentId, threadId]);

  useEffect(() => {
    if (!thread || !environmentId) return;
    const decision = computeDraftBodySync(thread);
    if (!decision) return;
    syncDraftBodyFromAssistantText({
      threadRef: { environmentId, threadId: thread.id },
      assistantText: decision.assistantText,
      streaming: decision.streaming,
    });
  }, [thread, environmentId]);
}
