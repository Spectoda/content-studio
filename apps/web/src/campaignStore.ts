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
 * via `threadId`; the store keeps the channel-scoped state that wraps those
 * threads.
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

export type DraftOutputStatus = "empty" | "generating" | "draft" | "review" | "approved";

export interface DraftOutput {
  id: string;
  campaignId: string;
  channel: ChannelId;
  title: string;
  body: string;
  bodyIsManuallyEdited: boolean;
  status: DraftOutputStatus;
  threadRef: ScopedThreadRef | null;
  updatedAt: string;
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
  draft: "Draft",
  in_progress: "In progress",
  ready: "Ready",
  archived: "Archived",
};

export const CAMPAIGN_STATUS_ORDER: CampaignStatus[] = [
  "in_progress",
  "ready",
  "draft",
  "archived",
];

export const DRAFT_STATUS_LABEL: Record<DraftOutputStatus, string> = {
  empty: "Empty",
  generating: "Generating",
  draft: "Draft",
  review: "Review",
  approved: "Approved",
};

// --- Persistence ----------------------------------------------------------

const CAMPAIGNS_STORAGE_KEY = "content-studio:campaigns:v1";

function loadCampaigns(): Campaign[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CAMPAIGNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Campaign[];
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
