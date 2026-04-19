/**
 * Campaign commands — orchestrate campaign lifecycle actions.
 *
 * These helpers are the bridge between the Campaign UI (forms, workspace,
 * draft editor) and the orchestration/provider runtime. A campaign owns one
 * provider thread per selected channel. Every turn — initial generation,
 * regeneration, follow-up — goes through the single `dispatchDraftTurn`
 * helper below so the `thread.turn.start` payload is constructed in exactly
 * one place.
 *
 * Each campaign is bound to a single environment captured at creation. All
 * dispatches go through `readEnvironmentApi(campaign.environmentId)`.
 *
 * Draft state has two independent axes — see `campaignStore.ts`:
 *  - `review`   : user-owned ("none" | "pending_changes" | "approved")
 *  - `progress` : orchestration-owned ("empty" | "generating" | "draft")
 * Commands in this file only touch `progress` / `body`; `review` is
 * written exclusively by UI handlers via `setDraftReview` / `saveDraftBody`.
 */

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
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
} from "./campaignChannels";

// --- Prompt builders ------------------------------------------------------

function buildBriefPreamble(campaign: Pick<Campaign, "name" | "brief" | "workingPrompt">): string {
  const lines: string[] = [`# Brief kampaně`, ``, `**Kampaň:** ${campaign.name}`];
  if (campaign.brief.trim().length > 0) {
    lines.push(``, `**Brief:**`, campaign.brief.trim());
  }
  if (campaign.workingPrompt.trim().length > 0) {
    lines.push(``, `**Pracovní prompt (jak má výstup působit):**`, campaign.workingPrompt.trim());
  }
  return lines.join("\n");
}

function buildChannelInstruction(channel: ChannelConfig): string {
  return [
    `# Tvůj úkol`,
    ``,
    `Napiš jeden výstup pro kanál ${channel.label} podle tohoto briefu.`,
    ``,
    `- Formát: ${channel.format}`,
    `- Cílová délka: ${channel.targetLength}`,
    `- Tón: ${channel.tone}`,
    `- Tip: ${channel.tip}`,
    ``,
    `Odpověz pouze finálním draftem. Nepřidávej meta komentáře, varianty ani`,
    `alternativy — vytvoř jednu čistou verzi, kterou content manager vloží do kanálu`,
    `tak, jak je. Pokud to pomáhá čitelnosti, použij markdown.`,
    ``,
    `Piš česky, pokud v briefu není explicitně požadován jiný jazyk.`,
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
    ? `\n\n## Feedback k zapracování\n${feedback}`
    : "\n\nPřepiš draft od začátku s jiným úhlem pohledu, ale drž se briefu.";
  return [
    `${buildChannelInstruction(options.channel)}`,
    `# Požadavek na revizi`,
    ``,
    `Předchozí draft nesedl. Vytvoř nový draft pro ${options.channel.label}.`,
    feedbackSection,
  ].join("\n");
}

function requireEnvironmentApi(environmentId: EnvironmentId) {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(
      `Prostředí ${environmentId} není dostupné. Akce kampaně vyžadují připojené prostředí.`,
    );
  }
  return api;
}

// --- Dispatch ---------------------------------------------------------------

type EnvironmentApi = ReturnType<typeof requireEnvironmentApi>;

interface DispatchDraftTurnOptions {
  api: EnvironmentApi;
  campaignName: string;
  channelLabel: string;
  threadId: ThreadId;
  prompt: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  /**
   * When the thread doesn't exist yet we include a `bootstrap.createThread`
   * directive so the provider creates the thread before running the turn.
   * `null` means the turn runs on an existing thread.
   */
  bootstrap: { projectId: ProjectId } | null;
  createdAt?: string;
}

/**
 * Shared implementation for starting a draft turn. `createCampaign`,
 * `regenerateDraft`, and `sendFollowUpToDraftThread` all dispatch the same
 * `thread.turn.start` command — they only differ in whether a new thread is
 * being bootstrapped. Keeping the payload construction in one place is the
 * whole point of this helper: any new invariant (title format, runtime
 * defaults, etc.) only needs to be encoded once.
 */
async function dispatchDraftTurn(options: DispatchDraftTurnOptions): Promise<void> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const title = truncate(`${options.campaignName} — ${options.channelLabel}`);

  await options.api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: options.threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: options.prompt,
      attachments: [],
    },
    modelSelection: options.modelSelection,
    titleSeed: title,
    runtimeMode: options.runtimeMode,
    interactionMode: options.interactionMode,
    ...(options.bootstrap
      ? {
          bootstrap: {
            createThread: {
              projectId: options.bootstrap.projectId,
              title,
              modelSelection: options.modelSelection,
              runtimeMode: options.runtimeMode,
              interactionMode: options.interactionMode,
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
    review: "none",
    progress: "generating",
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

      try {
        await dispatchDraftTurn({
          api,
          campaignName: campaign.name,
          channelLabel: channel.label,
          threadId,
          prompt,
          modelSelection: input.modelSelection,
          runtimeMode,
          interactionMode,
          bootstrap: { projectId: input.projectId },
          createdAt: now,
        });

        useCampaignStore.getState().updateDraft(campaignId, draft.id, {
          threadRef,
          progress: "generating",
        });
      } catch (error) {
        dispatchErrors.push({
          channel: draft.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        useCampaignStore.getState().updateDraft(campaignId, draft.id, {
          progress: "empty",
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
  /**
   * Explicit model selection for this regeneration. When omitted we fall back
   * to the per-draft `modelOverride`, then to the campaign default. When
   * provided we auto-persist it as the new `modelOverride` so the next
   * regeneration in the UI keeps the same choice without the caller having
   * to pass it in again.
   */
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  /** Used when the draft has no backing thread yet. */
  projectId?: ProjectId | null;
}

function resolveDraftModelSelection(
  explicit: ModelSelection | undefined,
  draft: Pick<DraftOutput, "modelOverride">,
  campaign: Pick<Campaign, "modelSelection">,
): ModelSelection {
  const resolved = explicit ?? draft.modelOverride ?? campaign.modelSelection;
  if (!resolved) {
    throw new Error(
      "Pro tento draft není dostupný žádný model. Vyberte model v editoru draftu nebo nastavte výchozí model kampaně.",
    );
  }
  return resolved;
}

function modelSelectionsEqual(
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function persistDraftModelOverrideIfChanged(options: {
  campaignId: string;
  draftId: string;
  picked: ModelSelection;
  draft: Pick<DraftOutput, "modelOverride">;
  campaign: Pick<Campaign, "modelSelection">;
}): void {
  const { picked, draft, campaign } = options;
  // If the user's pick already matches the persisted override, nothing to do.
  if (modelSelectionsEqual(picked, draft.modelOverride)) return;
  // If the pick matches the campaign default, we interpret that as "follow
  // the campaign" and clear the override (using `null` so the persisted
  // intent survives a reload).
  const store = useCampaignStore.getState();
  if (modelSelectionsEqual(picked, campaign.modelSelection)) {
    if (draft.modelOverride !== undefined && draft.modelOverride !== null) {
      store.updateDraft(options.campaignId, options.draftId, { modelOverride: null });
    }
    return;
  }
  store.updateDraft(options.campaignId, options.draftId, { modelOverride: picked });
}

export async function regenerateDraft(input: RegenerateDraftInput): Promise<void> {
  const store = useCampaignStore.getState();
  const campaign = store.getCampaignById(input.campaignId);
  if (!campaign) {
    throw new Error(`Neznámá kampaň: ${input.campaignId}`);
  }
  const draft = campaign.drafts.find((entry) => entry.id === input.draftId);
  if (!draft) {
    throw new Error(`Neznámý draft: ${input.draftId}`);
  }

  const channel = getChannelConfig(draft.channel);
  if (!channel) {
    throw new Error(`Neznámý kanál: ${draft.channel}`);
  }

  const api = requireEnvironmentApi(campaign.environmentId);

  const modelSelection = resolveDraftModelSelection(input.modelSelection, draft, campaign);
  // Auto-persist the explicit pick as the draft's override so the next run
  // keeps using it — but only when it actually differs from what the draft
  // would have resolved to without the override. That way:
  //   • Picking a model matching the current override is a no-op.
  //   • Picking a model matching the campaign default clears the override
  //     (so the draft goes back to "follow the campaign").
  //   • Picking anything else stores it as the new override.
  if (input.modelSelection) {
    persistDraftModelOverrideIfChanged({
      campaignId: input.campaignId,
      draftId: input.draftId,
      picked: input.modelSelection,
      draft,
      campaign,
    });
  }

  const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  const createdAt = new Date().toISOString();
  const prompt = buildRegenerationPrompt({
    campaign,
    channel,
    feedback: input.feedback ?? null,
  });
  const existingThreadId: ThreadId | null = draft.threadRef?.threadId ?? null;
  const threadId: ThreadId = existingThreadId ?? newThreadId();
  const threadRef: ScopedThreadRef = { environmentId: campaign.environmentId, threadId };

  const needsBootstrap = !existingThreadId;
  if (needsBootstrap && !input.projectId) {
    throw new Error("Regenerace selhala: draft nemá konverzaci a nebylo předáno projectId.");
  }

  store.updateDraft(input.campaignId, input.draftId, {
    progress: "generating",
    bodyIsManuallyEdited: false,
    body: "",
    threadRef,
  });

  await dispatchDraftTurn({
    api,
    campaignName: campaign.name,
    channelLabel: channel.label,
    threadId,
    prompt,
    modelSelection,
    runtimeMode,
    interactionMode,
    bootstrap: needsBootstrap && input.projectId ? { projectId: input.projectId } : null,
    createdAt,
  });
}

// --- Ad-hoc follow up (send a message on the draft's thread) -------------

export async function sendFollowUpToDraftThread(input: {
  campaignId: string;
  draftId: string;
  message: string;
  /**
   * Same resolve order as `regenerateDraft`: explicit argument → per-draft
   * `modelOverride` → `campaign.modelSelection`. Supplying it auto-persists
   * as the draft's override.
   */
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
}): Promise<void> {
  const store = useCampaignStore.getState();
  const campaign = store.getCampaignById(input.campaignId);
  if (!campaign) throw new Error(`Neznámá kampaň: ${input.campaignId}`);
  const draft = campaign.drafts.find((entry) => entry.id === input.draftId);
  if (!draft || !draft.threadRef) {
    throw new Error("Draft zatím nemá konverzaci. Nejdřív spusťte regeneraci.");
  }

  const api = requireEnvironmentApi(campaign.environmentId);

  const modelSelection = resolveDraftModelSelection(input.modelSelection, draft, campaign);
  if (input.modelSelection) {
    persistDraftModelOverrideIfChanged({
      campaignId: input.campaignId,
      draftId: input.draftId,
      picked: input.modelSelection,
      draft,
      campaign,
    });
  }

  store.updateDraft(input.campaignId, input.draftId, { progress: "generating" });

  const channel = getChannelConfig(draft.channel);
  await dispatchDraftTurn({
    api,
    campaignName: campaign.name,
    channelLabel: channel?.label ?? draft.channel,
    threadId: draft.threadRef.threadId,
    prompt: input.message,
    modelSelection,
    runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    bootstrap: null,
  });
}

// --- Draft body / progress helpers ---------------------------------------

/**
 * Sync the draft body + progress from its backing thread's current turn.
 *
 * Only touches the orchestration-owned axis (`progress`) and the `body`
 * field. User-owned `review` state is never written here — a draft that was
 * approved stays approved even if the user re-runs it; flipping it back is
 * the caller's responsibility.
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
  const nextProgress: DraftOutput["progress"] = options.streaming ? "generating" : "draft";

  if (draft.bodyIsManuallyEdited) {
    // The user owns the body. Still snap progress forward when a run
    // finishes so badges (which derive from progress) stop showing
    // "Generuji" after the AI is done.
    if (draft.progress !== nextProgress) {
      store.updateDraft(campaign.id, draft.id, { progress: nextProgress });
    }
    return;
  }

  if (draft.body === options.assistantText && draft.progress === nextProgress) {
    return;
  }
  store.updateDraft(campaign.id, draft.id, {
    body: options.assistantText,
    progress: nextProgress,
  });
}

export function saveDraftBody(
  campaignId: string,
  draftId: string,
  body: string,
  options?: { review?: DraftOutput["review"] },
): void {
  useCampaignStore.getState().updateDraft(campaignId, draftId, {
    body,
    bodyIsManuallyEdited: true,
    ...(options?.review !== undefined ? { review: options.review } : {}),
  });
}

/**
 * Mark the body as "authored by AI" again (used by "Vrátit na verzi od AI"
 * and by the follow-up confirmation flow). Clears `bodyIsManuallyEdited`
 * and, when provided, writes a concrete body snapshot atomically.
 */
export function acceptAiAuthoredBody(campaignId: string, draftId: string, body?: string): void {
  useCampaignStore.getState().updateDraft(campaignId, draftId, {
    bodyIsManuallyEdited: false,
    ...(body !== undefined ? { body } : {}),
  });
}

export function setDraftReview(
  campaignId: string,
  draftId: string,
  review: DraftOutput["review"],
): void {
  useCampaignStore.getState().updateDraft(campaignId, draftId, { review });
}

export function setCampaignStatus(campaignId: string, status: Campaign["status"]): void {
  useCampaignStore.getState().updateCampaign(campaignId, { status });
}
