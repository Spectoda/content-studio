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
  ClipboardCopyIcon,
  InfoIcon,
  Loader2Icon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ModelSelection, ProjectId } from "@t3tools/contracts";

import {
  type Campaign,
  deriveDraftStatus,
  type DraftOutput,
  type DraftOutputStatus,
  DRAFT_STATUS_LABEL,
  useCampaignStore,
} from "../campaignStore";
import { getChannelConfig, getChannelLabel } from "../campaignChannels";
import { regenerateDraft, setCampaignStatus, setDraftReview } from "../campaignCommands";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerProviders } from "../rpc/serverState";
import { useSettings } from "../hooks/useSettings";
import { selectProjectsForEnvironment, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useDraftBodySync } from "../hooks/useDraftBodySync";
import { CampaignModelPicker } from "./CampaignModelPicker";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SidebarTrigger } from "./ui/sidebar";

import { isElectron } from "../env";
import { toastManager } from "./ui/toast";

function DraftStatusBadge({ status }: { status: DraftOutputStatus }) {
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
        Čekám na první odpověď AI — draft se sem bude streamovat.
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
  const draftStatus = deriveDraftStatus(draft);
  const isGenerating = draftStatus === "generating";

  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition hover:border-sky-500/40">
      <header className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">
            {channelConfig?.label ?? draft.channel}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {channelConfig?.format ?? "Draft kanálu"} · {channelConfig?.targetLength ?? ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {isGenerating && <Loader2Icon className="size-3.5 animate-spin text-sky-500" />}
          <DraftStatusBadge status={draftStatus} />
        </div>
      </header>

      <div className="flex-1 px-4 py-3">
        <DraftPreview body={draft.body} />
        {draft.bodyIsManuallyEdited && (
          <p className="mt-2 text-[10px] font-medium uppercase tracking-wider text-amber-600">
            Ručně upraveno
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-border/70 bg-background/40 px-3 py-2">
        <Button size="sm" variant="default" className="gap-1" onClick={onOpen}>
          Otevřít
          <ArrowUpRightIcon className="size-3" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          onClick={onRegenerate}
          disabled={isGenerating}
          title={
            isGenerating
              ? "AI generuje nový draft — obvykle trvá 20–60 sekund."
              : "Požádat AI o novou verzi tohoto draftu. Předchozí text se nahradí."
          }
        >
          {isGenerating ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
          {isGenerating ? "Regeneruji…" : draft.threadRef ? "Regenerovat" : "Vygenerovat"}
        </Button>
        {draft.review !== "approved" ? (
          <Button size="sm" variant="ghost" className="gap-1" onClick={onApprove}>
            <CheckCircle2Icon className="size-3 text-emerald-500" />
            Schválit
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="gap-1" onClick={onMarkReview}>
            Znovu otevřít
          </Button>
        )}
        {draft.modelOverride ? (
          <div className="ms-auto min-w-0 shrink-0">
            <CampaignModelPicker
              value={draft.modelOverride}
              onChange={(next) =>
                useCampaignStore
                  .getState()
                  .updateDraft(campaign.id, draft.id, { modelOverride: next })
              }
              compact
              disabled={isGenerating}
            />
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto text-[10px] text-muted-foreground"
            onClick={onOpen}
            title="Používá se výchozí model kampaně. Otevřete editor draftu a vyberte jiný."
          >
            Model: výchozí
          </Button>
        )}
      </footer>
    </article>
  );
}

function formatModelSelection(selection: Campaign["modelSelection"] | undefined): string {
  if (!selection) return "—";
  const provider = selection.provider;
  const model = selection.model;
  // ModelSelection is a discriminated union — each provider has its own
  // option shape. Read opts through `unknown` + property check so we can
  // format the common knobs without a mega switch that needs updating
  // whenever upstream adds a provider.
  const opts = (selection.options ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof opts.reasoningEffort === "string") parts.push(opts.reasoningEffort);
  if (typeof opts.effort === "string") parts.push(opts.effort);
  if (opts.fastMode === true) parts.push("fast");
  if (opts.thinking === true) parts.push("thinking");
  return `${provider}/${model}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function CampaignTechnicalInfo({ campaign }: { campaign: Campaign }) {
  const rows = useMemo<Array<[string, string]>>(() => {
    const drafts = campaign.drafts;
    const threadsWithRef = drafts.filter((d) => d.threadRef);
    return [
      ["ID kampaně", campaign.id],
      ["Status", campaign.status],
      ["Vytvořeno", formatTimestamp(campaign.createdAt)],
      ["Poslední změna", formatTimestamp(campaign.updatedAt)],
      ["Prostředí", campaign.environmentId ?? "—"],
      ["Projekt", campaign.projectName ?? campaign.projectId ?? "—"],
      ["Cesta projektu", campaign.projectCwd ?? "—"],
      ["Výchozí model", formatModelSelection(campaign.modelSelection)],
      ["Drafty", `${drafts.length} (${threadsWithRef.length} s konverzací)`],
    ];
  }, [campaign]);

  const draftModelRows = useMemo<Array<{ channel: string; label: string }>>(() => {
    return campaign.drafts.map((draft) => ({
      channel: draft.channel,
      label: draft.modelOverride
        ? `${formatModelSelection(draft.modelOverride)} (override)`
        : `${formatModelSelection(campaign.modelSelection)} (výchozí)`,
    }));
  }, [campaign]);

  const copyToClipboard = useCallback(() => {
    const draftLines = draftModelRows.map(
      (entry) => `  ${entry.channel.padEnd(14)} ${entry.label}`,
    );
    const text = [...rows.map(([k, v]) => `${k}: ${v}`), "Modely draftů:", ...draftLines].join(
      "\n",
    );
    void navigator.clipboard.writeText(text).then(() => {
      toastManager.add({ type: "success", title: "Technické info zkopírováno do schránky" });
    });
  }, [rows, draftModelRows]);

  return (
    <details className="group rounded-xl border border-border/70 bg-background/40 text-[12px]">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-muted-foreground transition-colors hover:text-foreground">
        <InfoIcon className="size-3.5" />
        <span className="font-medium">Technické info</span>
        <span className="text-[10px] font-normal opacity-70">
          (užitečné při řešení problémů s vývojáři)
        </span>
      </summary>
      <div className="border-t border-border/70 px-3 pb-3 pt-2">
        <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1.5">
          {rows.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {key}
              </dt>
              <dd className="select-text break-all font-mono text-[11.5px] text-foreground/90">
                {value}
              </dd>
            </div>
          ))}
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Thread IDs
          </dt>
          <dd className="space-y-0.5 font-mono text-[11px] text-foreground/80">
            {campaign.drafts.map((draft) => (
              <div key={draft.id} className="truncate">
                <span className="inline-block w-20 opacity-70">{draft.channel}</span>
                <span className="select-text break-all">{draft.threadRef?.threadId ?? "—"}</span>
              </div>
            ))}
          </dd>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Modely draftů
          </dt>
          <dd className="space-y-0.5 font-mono text-[11px] text-foreground/80">
            {draftModelRows.map((entry) => (
              <div key={entry.channel} className="truncate">
                <span className="inline-block w-20 opacity-70">{entry.channel}</span>
                <span className="select-text break-all">{entry.label}</span>
              </div>
            ))}
          </dd>
        </dl>
        <Button size="sm" variant="outline" className="mt-3 gap-1" onClick={copyToClipboard}>
          <ClipboardCopyIcon className="size-3" />
          Zkopírovat info
        </Button>
      </div>
    </details>
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
    const ordered = projectOrder.filter((id): id is ProjectId =>
      projectIdSet.has(id),
    ) as ProjectId[];
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
        // When the draft has an override, pass it explicitly — this keeps
        // `regenerateDraft`'s internal resolve consistent with what the
        // Workspace shows in the DraftCard footer, even if the store was
        // updated between the last render and the click. When the draft has
        // no override, we deliberately omit `modelSelection` so the command
        // falls back to the campaign default — passing the campaign default
        // explicitly would trigger the auto-persist and turn "no override"
        // into "override == campaign default", which is a no-op today but
        // would mask the user's intent to keep following the campaign.
        //
        // If neither the draft nor the campaign has a model (older campaigns
        // created before the snapshot was persisted), we compute an app-level
        // default as a last-resort fallback.
        const modelSelection: ModelSelection | undefined = draft.modelOverride
          ? draft.modelOverride
          : campaign.modelSelection
            ? undefined
            : resolveAppModelSelectionState(settings, providers);
        await regenerateDraft({
          campaignId,
          draftId: draft.id,
          ...(modelSelection ? { modelSelection } : {}),
          projectId: fallbackProjectId,
        });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "Draft se nepodařilo regenerovat",
          description: err instanceof Error ? err.message : "Neznámá chyba.",
        });
      } finally {
        setRegeneratingDraftId((current) => (current === draft.id ? null : current));
      }
    },
    [campaign, campaignId, providers, settings, fallbackProjectId],
  );

  const handleApprove = useCallback(
    (draft: DraftOutput) => {
      setDraftReview(campaignId, draft.id, "approved");
    },
    [campaignId],
  );

  const handleReopen = useCallback(
    (draft: DraftOutput) => {
      setDraftReview(campaignId, draft.id, "pending_changes");
    },
    [campaignId],
  );

  if (!campaign) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background text-muted-foreground">
        <p className="text-sm">Kampaň nenalezena.</p>
        <Link to="/" className="mt-2 text-xs text-sky-500 hover:underline">
          Zpět do Content Studia
        </Link>
      </div>
    );
  }

  const approvedCount = campaign.drafts.filter((draft) => draft.review === "approved").length;
  const generatingCount = campaign.drafts.filter((draft) => draft.progress === "generating").length;
  const allApproved = approvedCount > 0 && approvedCount === campaign.drafts.length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent_45%),var(--background)] text-foreground">
      {!isElectron && (
        <header className="flex items-center gap-2 border-b border-border/70 px-4 py-2 md:hidden">
          <SidebarTrigger className="size-7 shrink-0" />
          <span className="truncate text-sm font-medium">{campaign.name || "Kampaň"}</span>
        </header>
      )}

      {isElectron && <div className="drag-region h-[52px] shrink-0 border-b border-border/70" />}

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-600">
                Kampaň
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{campaign.name}</h1>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {approvedCount}/{campaign.drafts.length} schváleno ·{" "}
                {generatingCount > 0 ? `${generatingCount} se generuje` : "nečinné"}
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
                  Označit kampaň jako hotovou
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
                Pracovní prompt
              </p>
              <p className="mt-1 whitespace-pre-wrap">{campaign.workingPrompt}</p>
            </div>
          )}

          <CampaignTechnicalInfo campaign={campaign} />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Drafty podle kanálu</h2>
            <p className="text-[11px] text-muted-foreground">
              Kliknutím na draft otevřete editor. Regenerace ovlivní jen tento kanál.
            </p>
          </div>

          {campaign.drafts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/80 bg-card/50 p-8 text-center text-sm text-muted-foreground">
              Zatím žádné drafty — při zakládání kampaně vyberte kanály, aby se zde objevily.
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
            <p className="mt-2 text-[11px] text-muted-foreground">Žádám o nový draft…</p>
          )}
        </section>
      </div>
    </div>
  );
}
