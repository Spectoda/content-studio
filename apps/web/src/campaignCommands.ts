/**
 * Campaign commands — orchestrate campaign lifecycle actions.
 *
 * These helpers are the bridge between the Campaign UI (forms, workspace,
 * draft editor) and the orchestration/provider runtime. A campaign owns one
 * provider thread per selected channel, so creation and regeneration map to
 * `thread.turn.start` commands with `bootstrap.createThread` for the first
 * turn and plain `thread.turn.start` for regenerations.
 *
 * Each campaign is bound to a single environment captured at creation. All
 * dispatches go through `readEnvironmentApi(campaign.environmentId)`.
 */

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";

import { readEnvironmentApi } from "./environmentApi";
import { newCommandId, newMessageId, newThreadId } from "./lib/utils";
import {
  type Campaign,
  createCampaignId,
  createDraftId,
  type DraftOutput,
  useCampaignStore,
} from "./campaignStore";
import {
  CAMPAIGN_CHANNELS,
  type ChannelConfig,
  type ChannelId,
  getChannelConfig,
  getChannelLabel,
} from "./campaignChannels";

// --- Prompt builders ------------------------------------------------------

function buildBriefPreamble(campaign: Pick<Campaign, "name" | "brief" | "workingPrompt">): string {
  const lines: string[] = [`# Campaign brief`, ``, `**Campaign:** ${campaign.name}`];
  if (campaign.brief.trim().length > 0) {
    lines.push(``, `**Brief:**`, campaign.brief.trim());
  }
  if (campaign.workingPrompt.trim().length > 0) {
    lines.push(
      ``,
      `**Working prompt (how the output should feel):**`,
      campaign.workingPrompt.trim(),
    );
  }
  return lines.join("\n");
}

function buildChannelInstruction(channel: ChannelConfig): string {
  return [
    `# Your task`,
    ``,
    `Write a single ${channel.label} output following this brief.`,
    ``,
    `- Format: ${channel.format}`,
    `- Target length: ${channel.targetLength}`,
    `- Tone: ${channel.tone}`,
    `- Tip: ${channel.tip}`,
    ``,
    `Respond with the final draft only. Do not include meta commentary, options, or`,
    `alternatives — produce one clean version that a content manager can copy into`,
    `the channel as-is. Use markdown for structure when it helps readability.`,
  ].join("\n");
}

export function buildInitialChannelPrompt(
  campaign: Pick<Campaign, "name" | "brief" | "workingPrompt">,
  channel: ChannelConfig,
): string {
  return `${buildBriefPreamble(campaign)}\n\n${buildChannelInstruction(channel)}`;
}

export function buildRegenerationPrompt(options: {
  campaign: Pick<Campaign, "name" | "brief" | "workingPrompt">;
  channel: ChannelConfig;
  feedback?: string | null;
}): string {
  const feedback = options.feedback?.trim() ?? "";
  const feedbackSection = feedback
    ? `\n\n## Feedback to apply\n${feedback}`
    : "\n\nRewrite the draft from scratch with a different angle while keeping the brief intact.";
  return [
    `${buildChannelInstruction(options.channel)}`,
    `# Revision request`,
    ``,
    `The previous draft was not the right fit. Produce a new ${options.channel.label} draft.`,
    feedbackSection,
  ].join("\n");
}

function requireEnvironmentApi(environmentId: EnvironmentId) {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(
      `Environment ${environmentId} is not available. Campaign actions require a connected environment.`,
    );
  }
  return api;
}

// --- Create campaign ------------------------------------------------------

export interface CreateCampaignInput {
  environmentId: EnvironmentId;
  name: string;
  brief: string;
  workingPrompt: string;
  selectedChannels: ChannelId[];
  projectId: ProjectId;
  /**
   * Display metadata for the project — captured on the caller side so
   * CampaignWorkspace can later show the cwd/name in the "Technical info"
   * panel without re-resolving the store (handy when the project is renamed
   * or deleted after a campaign was created).
   */
  projectName?: string;
  projectCwd?: string;
  modelSelection: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
}

export interface CreateCampaignResult {
  campaign: Campaign;
  dispatchErrors: Array<{ channel: ChannelId; error: string }>;
}

/**
 * Creates a campaign with one thread per selected channel. Each thread is
 * seeded with the campaign brief plus a channel-specific instruction and the
 * first turn is started immediately so drafts stream in the background.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<CreateCampaignResult> {
  const api = requireEnvironmentApi(input.environmentId);

  const now = new Date().toISOString();
  const campaignId = createCampaignId();
  const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;

  const orderedChannels = CAMPAIGN_CHANNELS.filter((channel) =>
    input.selectedChannels.includes(channel.id),
  );

  const drafts: DraftOutput[] = orderedChannels.map((channel) => ({
    id: createDraftId(),
    campaignId,
    channel: channel.id,
    title: `${input.name} — ${channel.label}`,
    body: "",
    bodyIsManuallyEdited: false,
    status: "generating",
    threadRef: null,
    updatedAt: now,
  }));

  const campaign: Campaign = {
    id: campaignId,
    environmentId: input.environmentId,
    name: input.name.trim(),
    brief: input.brief.trim(),
    workingPrompt: input.workingPrompt.trim(),
    selectedChannels: orderedChannels.map((channel) => channel.id),
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
    drafts,
    projectId: input.projectId,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    ...(input.projectCwd ? { projectCwd: input.projectCwd } : {}),
    modelSelection: input.modelSelection,
  };

  useCampaignStore.getState().addCampaign(campaign);

  const dispatchErrors: Array<{ channel: ChannelId; error: string }> = [];

  await Promise.all(
    drafts.map(async (draft) => {
      const channel = getChannelConfig(draft.channel);
      if (!channel) return;
      const threadId = newThreadId();
      const threadRef: ScopedThreadRef = { environmentId: input.environmentId, threadId };
      const prompt = buildInitialChannelPrompt(campaign, channel);
      const title = truncate(`${campaign.name} — ${channel.label}`);

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection: input.modelSelection,
          titleSeed: title,
          runtimeMode,
          interactionMode,
          bootstrap: {
            createThread: {
              projectId: input.projectId,
              title,
              modelSelection: input.modelSelection,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: now,
            },
          },
          createdAt: now,
        });

        useCampaignStore.getState().updateDraft(campaignId, draft.id, {
          threadRef,
          status: "generating",
        });
      } catch (error) {
        dispatchErrors.push({
          channel: draft.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        useCampaignStore.getState().updateDraft(campaignId, draft.id, {
          status: "empty",
          threadRef: null,
        });
      }
    }),
  );

  return {
    campaign: useCampaignStore.getState().getCampaignById(campaignId) ?? campaign,
    dispatchErrors,
  };
}

// --- Regenerate draft -----------------------------------------------------

export interface RegenerateDraftInput {
  campaignId: string;
  draftId: string;
  feedback?: string | null;
  modelSelection: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  /** Used when the draft has no backing thread yet. */
  projectId?: ProjectId | null;
}

export async function regenerateDraft(input: RegenerateDraftInput): Promise<void> {
  const store = useCampaignStore.getState();
  const campaign = store.getCampaignById(input.campaignId);
  if (!campaign) {
    throw new Error(`Unknown campaign: ${input.campaignId}`);
  }
  const draft = campaign.drafts.find((entry) => entry.id === input.draftId);
  if (!draft) {
    throw new Error(`Unknown draft: ${input.draftId}`);
  }

  const channel = getChannelConfig(draft.channel);
  if (!channel) {
    throw new Error(`Unknown channel: ${draft.channel}`);
  }

  const api = requireEnvironmentApi(campaign.environmentId);

  const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  const createdAt = new Date().toISOString();
  const prompt = buildRegenerationPrompt({
    campaign,
    channel,
    feedback: input.feedback ?? null,
  });
  const title = truncate(`${campaign.name} — ${channel.label}`);
  const existingThreadId: ThreadId | null = draft.threadRef?.threadId ?? null;
  const threadId: ThreadId = existingThreadId ?? newThreadId();
  const threadRef: ScopedThreadRef = { environmentId: campaign.environmentId, threadId };

  const needsBootstrap = !existingThreadId;
  if (needsBootstrap && !input.projectId) {
    throw new Error("Cannot regenerate: draft has no thread and no projectId was provided.");
  }

  store.updateDraft(input.campaignId, input.draftId, {
    status: "generating",
    bodyIsManuallyEdited: false,
    body: "",
    threadRef,
  });

  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: prompt,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: title,
    runtimeMode,
    interactionMode,
    ...(needsBootstrap && input.projectId
      ? {
          bootstrap: {
            createThread: {
              projectId: input.projectId,
              title,
              modelSelection: input.modelSelection,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
        }
      : {}),
    createdAt,
  });
}

// --- Ad-hoc follow up (send a message on the draft's thread) -------------

export async function sendFollowUpToDraftThread(input: {
  campaignId: string;
  draftId: string;
  message: string;
  modelSelection: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
}): Promise<void> {
  const store = useCampaignStore.getState();
  const campaign = store.getCampaignById(input.campaignId);
  if (!campaign) throw new Error(`Unknown campaign: ${input.campaignId}`);
  const draft = campaign.drafts.find((entry) => entry.id === input.draftId);
  if (!draft || !draft.threadRef) {
    throw new Error("Draft has no underlying thread yet. Regenerate first.");
  }

  const api = requireEnvironmentApi(campaign.environmentId);

  store.updateDraft(input.campaignId, input.draftId, { status: "generating" });

  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: draft.threadRef.threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: input.message,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: new Date().toISOString(),
  });
}

// --- Draft body / status helpers -----------------------------------------

/**
 * Sync the draft body from its backing thread's latest assistant message,
 * unless the body has been manually edited.
 */
export function syncDraftBodyFromAssistantText(options: {
  threadRef: ScopedThreadRef;
  assistantText: string;
  streaming: boolean;
}): void {
  const store = useCampaignStore.getState();
  const match = store.findDraftByThreadRef(options.threadRef);
  if (!match) return;

  const { campaign, draft } = match;
  if (draft.bodyIsManuallyEdited) {
    if (draft.status === "generating" && !options.streaming) {
      store.updateDraft(campaign.id, draft.id, { status: "draft" });
    }
    return;
  }

  const nextStatus: DraftOutput["status"] = options.streaming ? "generating" : "draft";
  if (draft.body === options.assistantText && draft.status === nextStatus) {
    return;
  }
  store.updateDraft(campaign.id, draft.id, {
    body: options.assistantText,
    status: nextStatus,
  });
}

export function saveDraftBody(
  campaignId: string,
  draftId: string,
  body: string,
  options?: { status?: DraftOutput["status"] },
): void {
  useCampaignStore.getState().updateDraft(campaignId, draftId, {
    body,
    bodyIsManuallyEdited: true,
    ...(options?.status ? { status: options.status } : {}),
  });
}

export function setDraftStatus(
  campaignId: string,
  draftId: string,
  status: DraftOutput["status"],
): void {
  useCampaignStore.getState().updateDraft(campaignId, draftId, { status });
}

export function setCampaignStatus(campaignId: string, status: Campaign["status"]): void {
  useCampaignStore.getState().updateCampaign(campaignId, { status });
}

// --- Convenience ----------------------------------------------------------

export function channelLabel(channel: string): string {
  return getChannelLabel(channel);
}

// Re-export for consumers that want a one-stop import.
export { CommandId, MessageId };
