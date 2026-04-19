/**
 * Content Studio — Campaign data model.
 *
 * A Campaign is the primary unit of work in Content Studio. The user defines
 * a topic, brief, working prompt, and a set of target channels. For each
 * channel Content Studio produces an independent DraftOutput that can be
 * edited, approved, or regenerated in isolation.
 *
 * Campaigns and drafts are persisted to localStorage so the UI can boot
 * offline. AI generation lives on provider threads referenced by each draft
 * via `threadRef`; the store keeps the channel-scoped state that wraps those
 * threads.
 *
 * ## Two-axis draft state
 *
 * Draft state is deliberately split along two independent axes to avoid the
 * race conditions a single `status` field used to cause (see the regression
 * test in `useDraftBodySync.test.ts` for the motivating bug):
 *
 *  - `review`   — user intent ("none" / "pending_changes" / "approved"),
 *                 written only by UI handlers.
 *  - `progress` — orchestration progress ("empty" / "generating" / "draft"),
 *                 written only by `campaignCommands` and the sync hook.
 *
 * The flat `DraftOutputStatus` used by badges and chips is derived from
 * both axes via `deriveDraftStatus` and must never be stored.
 */

import { create } from "zustand";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import { type ChannelId } from "./campaignChannels";

export type CampaignStatus = "draft" | "in_progress" | "ready" | "archived";

/**
 * The user-owned review state of a draft. Independent of whether the AI is
 * currently producing output. "none" is the default (no explicit user
 * decision yet); "pending_changes" is the legacy "review" status (user asked
 * for changes); "approved" marks the draft as ready to ship.
 */
export type DraftReview = "none" | "pending_changes" | "approved";

/**
 * The orchestration-owned progress state of a draft. Describes only whether
 * the backing thread has produced any output and whether a turn is currently
 * running. Writes to this field belong exclusively to `campaignCommands` and
 * `useDraftBodySync` — never to UI handlers.
 */
export type DraftProgress = "empty" | "generating" | "draft";

/**
 * Legacy flat status used by UI surfaces (badges, chips, sidebar). Derived
 * on read from (`review`, `progress`) via `deriveDraftStatus`. Keeping this
 * type exported so existing consumers can keep their current label/colour
 * maps without immediate changes.
 */
export type DraftOutputStatus = DraftProgress | "review" | "approved";

export interface DraftOutput {
  id: string;
  campaignId: string;
  channel: ChannelId;
  title: string;
  body: string;
  bodyIsManuallyEdited: boolean;
  /**
   * User-owned review state. Defaults to "none" for freshly generated drafts.
   * Only UI handlers (approve / request changes) write to this field.
   */
  review: DraftReview;
  /**
   * Orchestration-owned progress. Only `campaignCommands` and the sync hook
   * write to this field — UI handlers must not touch it.
   */
  progress: DraftProgress;
  threadRef: ScopedThreadRef | null;
  updatedAt: string;
  /**
   * Per-draft model override. When set, regenerations for this draft use this
   * `ModelSelection` instead of `Campaign.modelSelection`. Marketing uses this
   * to experiment with different providers/models per channel inside a single
   * campaign (e.g. Claude for newsletter, Codex for LinkedIn).
   *
   * - `undefined` — never set; regenerations fall back to `Campaign.modelSelection`.
   * - `null`      — user explicitly reset back to the campaign default
   *                 (persisted as `null` in localStorage so the intent survives a reload).
   * - `ModelSelection` — the explicit per-draft choice.
   */
  modelOverride?: ModelSelection | null;
}

/**
 * Collapse the two-axis (review, progress) model into the flat status used by
 * badges and chips. Review beats progress: an approved draft stays "approved"
 * even if a new turn is somehow streaming in the background.
 */
export function deriveDraftStatus(
  draft: Pick<DraftOutput, "review" | "progress">,
): DraftOutputStatus {
  if (draft.review === "approved") return "approved";
  if (draft.review === "pending_changes") return "review";
  return draft.progress;
}

export interface Campaign {
  id: string;
  environmentId: EnvironmentId;
  name: string;
  brief: string;
  workingPrompt: string;
  selectedChannels: ChannelId[];
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  drafts: DraftOutput[];
  // Troubleshooting snapshot — captured at creation so non-technical users can
  // report "which model ran where" without digging through logs. Optional
  // because campaigns persisted from earlier versions don't have these fields.
  projectId?: ProjectId;
  projectName?: string;
  projectCwd?: string;
  modelSelection?: ModelSelection;
}

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Rozepsané",
  in_progress: "Probíhá",
  ready: "Hotové",
  archived: "Archivováno",
};

export const CAMPAIGN_STATUS_ORDER: CampaignStatus[] = [
  "in_progress",
  "ready",
  "draft",
  "archived",
];

export const DRAFT_STATUS_LABEL: Record<DraftOutputStatus, string> = {
  empty: "Prázdné",
  generating: "Generuji",
  draft: "Draft",
  review: "Ke kontrole",
  approved: "Schváleno",
};

// --- Persistence ----------------------------------------------------------

const CAMPAIGNS_STORAGE_KEY = "content-studio:campaigns:v1";

/**
 * Shape of legacy drafts persisted before `review`/`progress` were split out
 * of the single `status` field. We still read these so upgrading the app
 * doesn't wipe saved campaigns.
 */
export interface LegacyDraftOutput extends Omit<DraftOutput, "review" | "progress"> {
  status?: DraftOutputStatus;
  review?: DraftReview;
  progress?: DraftProgress;
}

export function migrateDraft(entry: LegacyDraftOutput): DraftOutput {
  if (entry.review && entry.progress) {
    // Already on the new schema.
    const { status: _legacyStatus, ...rest } = entry;
    void _legacyStatus;
    return { ...rest, review: entry.review, progress: entry.progress };
  }
  const legacyStatus = entry.status ?? "empty";
  const review: DraftReview =
    legacyStatus === "approved"
      ? "approved"
      : legacyStatus === "review"
        ? "pending_changes"
        : "none";
  const progress: DraftProgress =
    legacyStatus === "generating" ? "generating" : legacyStatus === "empty" ? "empty" : "draft";
  const { status: _legacyStatus, ...rest } = entry;
  void _legacyStatus;
  return { ...rest, review, progress };
}

function migrateCampaign(campaign: Campaign & { drafts: LegacyDraftOutput[] }): Campaign {
  return { ...campaign, drafts: campaign.drafts.map(migrateDraft) };
}

function loadCampaigns(): Campaign[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CAMPAIGNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Campaign & { drafts: LegacyDraftOutput[] }>).map(migrateCampaign);
  } catch {
    return [];
  }
}

function persistCampaigns(campaigns: Campaign[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CAMPAIGNS_STORAGE_KEY, JSON.stringify(campaigns));
  } catch {
    // Storage unavailable or full; nothing to recover here.
  }
}

// --- Helpers --------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString();
}

export function createCampaignId(): string {
  return `camp_${crypto.randomUUID().slice(0, 8)}`;
}

export function createDraftId(): string {
  return `draft_${crypto.randomUUID().slice(0, 8)}`;
}

// --- Store ----------------------------------------------------------------

interface CampaignStoreState {
  campaigns: Campaign[];
  setCampaigns: (campaigns: Campaign[]) => void;
  addCampaign: (campaign: Campaign) => void;
  updateCampaign: (id: string, updates: Partial<Omit<Campaign, "id" | "drafts">>) => void;
  removeCampaign: (id: string) => void;
  getCampaignById: (id: string) => Campaign | undefined;
  upsertDraft: (campaignId: string, draft: DraftOutput) => void;
  updateDraft: (
    campaignId: string,
    draftId: string,
    updates: Partial<Omit<DraftOutput, "id" | "campaignId">>,
  ) => void;
  getDraftByChannel: (campaignId: string, channel: ChannelId) => DraftOutput | undefined;
  findCampaignByThreadId: (threadId: ThreadId) => Campaign | undefined;
  findDraftByThreadId: (
    threadId: ThreadId,
  ) => { campaign: Campaign; draft: DraftOutput } | undefined;
  findCampaignByThreadRef: (threadRef: ScopedThreadRef) => Campaign | undefined;
  findDraftByThreadRef: (
    threadRef: ScopedThreadRef,
  ) => { campaign: Campaign; draft: DraftOutput } | undefined;
}

export const useCampaignStore = create<CampaignStoreState>((set, get) => {
  const initial = loadCampaigns();

  const commit = (next: Campaign[]): void => {
    persistCampaigns(next);
    set({ campaigns: next });
  };

  return {
    campaigns: initial,

    setCampaigns: (campaigns) => commit(campaigns),

    addCampaign: (campaign) => {
      commit([...get().campaigns, campaign]);
    },

    updateCampaign: (id, updates) => {
      const next = get().campaigns.map((campaign) =>
        campaign.id === id ? { ...campaign, ...updates, updatedAt: timestamp() } : campaign,
      );
      commit(next);
    },

    removeCampaign: (id) => {
      commit(get().campaigns.filter((campaign) => campaign.id !== id));
    },

    getCampaignById: (id) => get().campaigns.find((campaign) => campaign.id === id),

    upsertDraft: (campaignId, draft) => {
      const next = get().campaigns.map((campaign) => {
        if (campaign.id !== campaignId) return campaign;
        const existingIndex = campaign.drafts.findIndex((entry) => entry.id === draft.id);
        const drafts =
          existingIndex === -1
            ? [...campaign.drafts, draft]
            : campaign.drafts.map((entry, index) => (index === existingIndex ? draft : entry));
        return { ...campaign, drafts, updatedAt: timestamp() };
      });
      commit(next);
    },

    updateDraft: (campaignId, draftId, updates) => {
      const next = get().campaigns.map((campaign) => {
        if (campaign.id !== campaignId) return campaign;
        const drafts = campaign.drafts.map((entry) =>
          entry.id === draftId ? { ...entry, ...updates, updatedAt: timestamp() } : entry,
        );
        return { ...campaign, drafts, updatedAt: timestamp() };
      });
      commit(next);
    },

    getDraftByChannel: (campaignId, channel) => {
      const campaign = get().campaigns.find((entry) => entry.id === campaignId);
      return campaign?.drafts.find((entry) => entry.channel === channel);
    },

    findCampaignByThreadId: (threadId) => {
      for (const campaign of get().campaigns) {
        if (campaign.drafts.some((draft) => draft.threadRef?.threadId === threadId)) {
          return campaign;
        }
      }
      return undefined;
    },

    findDraftByThreadId: (threadId) => {
      for (const campaign of get().campaigns) {
        const draft = campaign.drafts.find((entry) => entry.threadRef?.threadId === threadId);
        if (draft) {
          return { campaign, draft };
        }
      }
      return undefined;
    },

    findCampaignByThreadRef: (threadRef) => {
      for (const campaign of get().campaigns) {
        if (
          campaign.drafts.some(
            (draft) =>
              draft.threadRef?.environmentId === threadRef.environmentId &&
              draft.threadRef?.threadId === threadRef.threadId,
          )
        ) {
          return campaign;
        }
      }
      return undefined;
    },

    findDraftByThreadRef: (threadRef) => {
      for (const campaign of get().campaigns) {
        const draft = campaign.drafts.find(
          (entry) =>
            entry.threadRef?.environmentId === threadRef.environmentId &&
            entry.threadRef?.threadId === threadRef.threadId,
        );
        if (draft) {
          return { campaign, draft };
        }
      }
      return undefined;
    },
  };
});
