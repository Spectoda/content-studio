/**
 * CampaignWorkspace — the overview screen for a single campaign.
 *
 * Shows the campaign brief on the left and a stack of per-channel draft
 * cards on the right. Each card exposes status, a body preview, and quick
 * actions (open editor, regenerate, approve). The workspace is the landing
 * area after creating or selecting a campaign from the sidebar.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CheckCircle2Icon,
  Loader2Icon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ProjectId } from "@t3tools/contracts";

import {
  type Campaign,
  type DraftOutput,
  DRAFT_STATUS_LABEL,
  useCampaignStore,
} from "../campaignStore";
import { getChannelConfig, getChannelLabel } from "../campaignChannels";
import { regenerateDraft, setCampaignStatus, setDraftStatus } from "../campaignCommands";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerProviders } from "../rpc/serverState";
import { useSettings } from "../hooks/useSettings";
import { selectProjectsForEnvironment, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useDraftBodySync } from "../hooks/useDraftBodySync";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SidebarTrigger } from "./ui/sidebar";

import { isElectron } from "../env";
import { toastManager } from "./ui/toast";

function DraftStatusBadge({ status }: { status: DraftOutput["status"] }) {
  const className =
    status === "approved"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : status === "review"
        ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30"
        : status === "generating"
          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30"
          : status === "empty"
            ? "bg-muted text-muted-foreground border-border"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
  return (
    <Badge variant="outline" className={`text-[10px] ${className}`}>
      {DRAFT_STATUS_LABEL[status]}
    </Badge>
  );
}

function DraftPreview({ body }: { body: string }) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return (
      <p className="text-[12px] italic text-muted-foreground">
        Waiting for the first AI response — the draft will stream in here.
      </p>
    );
  }
  const preview = trimmed.length > 480 ? `${trimmed.slice(0, 480).trimEnd()}…` : trimmed;
  return (
    <p className="line-clamp-6 whitespace-pre-wrap text-[12.5px] leading-5 text-foreground/90">
      {preview}
    </p>
  );
}

function DraftCard({
  campaign,
  draft,
  onOpen,
  onRegenerate,
  onApprove,
  onMarkReview,
}: {
  campaign: Campaign;
  draft: DraftOutput;
  onOpen: () => void;
  onRegenerate: () => void;
  onApprove: () => void;
  onMarkReview: () => void;
}) {
  useDraftBodySync(draft.threadRef);
  const channelConfig = getChannelConfig(draft.channel);
  const isGenerating = draft.status === "generating";

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:border-sky-500/40">
      <header className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">
            {channelConfig?.label ?? draft.channel}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {channelConfig?.format ?? "Channel draft"} · {channelConfig?.targetLength ?? ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {isGenerating && <Loader2Icon className="size-3.5 animate-spin text-sky-500" />}
          <DraftStatusBadge status={draft.status} />
        </div>
      </header>

      <div className="flex-1 px-4 py-3">
        <DraftPreview body={draft.body} />
        {draft.bodyIsManuallyEdited && (
          <p className="mt-2 text-[10px] font-medium uppercase tracking-wider text-amber-600">
            Manually edited
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-border/70 bg-background/40 px-3 py-2">
        <Button size="sm" variant="default" className="gap-1" onClick={onOpen}>
          Open
          <ArrowUpRightIcon className="size-3" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={onRegenerate}
          disabled={isGenerating}
          title={campaign.name}
        >
          <RefreshCwIcon className="size-3" />
          {draft.body.trim().length === 0 ? "Generate" : "Regenerate"}
        </Button>
        {draft.status !== "approved" ? (
          <Button size="sm" variant="ghost" className="gap-1" onClick={onApprove}>
            <CheckCircle2Icon className="size-3 text-emerald-500" />
            Approve
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="gap-1" onClick={onMarkReview}>
            Reopen
          </Button>
        )}
      </footer>
    </article>
  );
}

export function CampaignWorkspace({ campaignId }: { campaignId: string }) {
  const navigate = useNavigate();
  const campaign = useCampaignStore((store) => store.getCampaignById(campaignId));
  const providers = useServerProviders();
  const settings = useSettings();
  const environmentId = campaign?.environmentId ?? null;
  const projectIds = useStore(
    useShallow((store) =>
      selectProjectsForEnvironment(store, environmentId).map((project) => project.id),
    ),
  );
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const orderedProjectIds = useMemo<ProjectId[]>(() => {
    if (projectOrder.length === 0) return projectIds;
    const projectIdSet = new Set<string>(projectIds);
    const ordered = projectOrder.filter((id): id is ProjectId => projectIdSet.has(id)) as ProjectId[];
    const remaining = projectIds.filter((id) => !projectOrder.includes(id));
    return [...ordered, ...remaining];
  }, [projectIds, projectOrder]);
  const fallbackProjectId: ProjectId | null = orderedProjectIds[0] ?? null;
  const [regeneratingDraftId, setRegeneratingDraftId] = useState<string | null>(null);

  const handleOpenDraft = useCallback(
    (draft: DraftOutput) => {
      void navigate({
        to: "/campaigns/$campaignId/$channel",
        params: { campaignId, channel: draft.channel },
      });
    },
    [campaignId, navigate],
  );

  const handleRegenerate = useCallback(
    async (draft: DraftOutput) => {
      if (!campaign) return;
      setRegeneratingDraftId(draft.id);
      try {
        const modelSelection = resolveAppModelSelectionState(settings, providers);
        await regenerateDraft({
          campaignId,
          draftId: draft.id,
          modelSelection,
          projectId: fallbackProjectId,
        });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "Could not regenerate draft",
          description: err instanceof Error ? err.message : "Unknown error.",
        });
      } finally {
        setRegeneratingDraftId((current) => (current === draft.id ? null : current));
      }
    },
    [campaign, campaignId, providers, settings, fallbackProjectId],
  );

  const handleApprove = useCallback(
    (draft: DraftOutput) => {
      setDraftStatus(campaignId, draft.id, "approved");
    },
    [campaignId],
  );

  const handleReopen = useCallback(
    (draft: DraftOutput) => {
      setDraftStatus(campaignId, draft.id, "review");
    },
    [campaignId],
  );

  if (!campaign) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background text-muted-foreground">
        <p className="text-sm">Campaign not found.</p>
        <Link to="/" className="mt-2 text-xs text-sky-500 hover:underline">
          Back to Content Studio
        </Link>
      </div>
    );
  }

  const approvedCount = campaign.drafts.filter((draft) => draft.status === "approved").length;
  const generatingCount = campaign.drafts.filter((draft) => draft.status === "generating").length;
  const allApproved = approvedCount > 0 && approvedCount === campaign.drafts.length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent_45%),var(--background)] text-foreground">
      {!isElectron && (
        <header className="flex items-center gap-2 border-b border-border/70 px-4 py-2 md:hidden">
          <SidebarTrigger className="size-7 shrink-0" />
          <span className="truncate text-sm font-medium">{campaign.name || "Campaign"}</span>
        </header>
      )}

      {isElectron && <div className="drag-region h-[52px] shrink-0 border-b border-border/70" />}

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-600">
                Campaign
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{campaign.name}</h1>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {approvedCount}/{campaign.drafts.length} approved ·{" "}
                {generatingCount > 0 ? `${generatingCount} generating` : "idle"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {campaign.selectedChannels.map((channelId) => (
                <Badge key={channelId} variant="outline" className="text-[10px]">
                  {getChannelLabel(channelId)}
                </Badge>
              ))}
              {allApproved && campaign.status !== "ready" && (
                <Button
                  size="sm"
                  variant="default"
                  className="gap-1"
                  onClick={() => setCampaignStatus(campaign.id, "ready")}
                >
                  <SparklesIcon className="size-3" />
                  Mark campaign ready
                </Button>
              )}
            </div>
          </div>

          {campaign.brief.trim().length > 0 && (
            <div className="rounded-xl border border-border/70 bg-background/50 p-3 text-[12.5px] leading-5 text-foreground/90">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Brief
              </p>
              <p className="mt-1 whitespace-pre-wrap">{campaign.brief}</p>
            </div>
          )}
          {campaign.workingPrompt.trim().length > 0 && (
            <div className="rounded-xl border border-border/70 bg-background/50 p-3 text-[12.5px] leading-5 text-foreground/90">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Working prompt
              </p>
              <p className="mt-1 whitespace-pre-wrap">{campaign.workingPrompt}</p>
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Drafts by channel</h2>
            <p className="text-[11px] text-muted-foreground">
              Click a draft to open the editor. Regenerating affects only that channel.
            </p>
          </div>

          {campaign.drafts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/80 bg-card/50 p-8 text-center text-sm text-muted-foreground">
              No drafts yet — pick channels when creating the campaign to populate this view.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {campaign.drafts.map((draft) => (
                <DraftCard
                  key={draft.id}
                  campaign={campaign}
                  draft={draft}
                  onOpen={() => handleOpenDraft(draft)}
                  onRegenerate={() => void handleRegenerate(draft)}
                  onApprove={() => handleApprove(draft)}
                  onMarkReview={() => handleReopen(draft)}
                />
              ))}
            </div>
          )}
          {regeneratingDraftId !== null && (
            <p className="mt-2 text-[11px] text-muted-foreground">Requesting new draft…</p>
          )}
        </section>
      </div>
    </div>
  );
}
