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

export function useDraftBodySync(threadRef: ScopedThreadRef | null | undefined): void {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const selector = useMemo(
    () =>
      createThreadSelectorByRef(
        environmentId && threadId ? { environmentId, threadId } : null,
      ),
    [environmentId, threadId],
  );
  const thread = useStore(selector);

  useEffect(() => {
    if (!environmentId || !threadId) return;
    return retainThreadDetailSubscription(environmentId, threadId);
  }, [environmentId, threadId]);

  useEffect(() => {
    if (!thread || !environmentId) return;
    let latestAssistant: { text: string; streaming: boolean } | null = null;
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const message = thread.messages[index];
      if (message && message.role === "assistant") {
        latestAssistant = { text: message.text, streaming: message.streaming };
        break;
      }
    }
    if (!latestAssistant) return;
    if (latestAssistant.text.trim().length === 0 && latestAssistant.streaming) return;

    syncDraftBodyFromAssistantText({
      threadRef: { environmentId, threadId: thread.id },
      assistantText: latestAssistant.text,
      streaming: latestAssistant.streaming,
    });
  }, [thread, environmentId]);
}
