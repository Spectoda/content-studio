/**
 * Keep a campaign draft's body in sync with the latest assistant message on
 * its backing thread. When the user manually edits the body, that override
 * wins and no further sync happens until they explicitly regenerate.
 */

import { useEffect, useMemo } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { syncDraftBodyFromAssistantText } from "../campaignCommands";
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
