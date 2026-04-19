/**
 * CampaignDraftEditor — single-channel draft editor.
 *
 * The user lands here after clicking "Open" on a draft card (or selecting a
 * draft row in the sidebar). The editor has three zones:
 *
 *   1. Header with campaign / channel metadata and primary actions.
 *   2. Markdown body editor on the left. Edits flip the draft into a
 *      manually-authored state so it stops being overwritten by streaming AI
 *      output.
 *   3. AI working copy on the right. Shows the latest assistant reply and a
 *      quick-feedback box for asking the backing thread for another pass.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ClipboardCopyIcon,
  EyeIcon,
  InfoIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  SendIcon,
  SparklesIcon,
  SplitIcon,
  UndoIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ModelSelection, ProjectId } from "@t3tools/contracts";

import { getChannelConfig } from "../campaignChannels";
import {
  regenerateDraft,
  saveDraftBody,
  sendFollowUpToDraftThread,
  setDraftStatus,
} from "../campaignCommands";
import { type DraftOutput, DRAFT_STATUS_LABEL, useCampaignStore } from "../campaignStore";
import { useDraftBodySync } from "../hooks/useDraftBodySync";
import { useSettings } from "../hooks/useSettings";
import { isElectron } from "../env";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerProviders } from "../rpc/serverState";
import { selectProjectsForEnvironment, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import { CampaignModelPicker } from "./CampaignModelPicker";
import ChatMarkdown from "./ChatMarkdown";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SidebarTrigger } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

type BodyViewMode = "edit" | "preview" | "split";

const BODY_VIEW_MODE_STORAGE_KEY = "content-studio:draft-view-mode";

function readInitialBodyViewMode(): BodyViewMode {
  if (typeof localStorage === "undefined") return "edit";
  const raw = localStorage.getItem(BODY_VIEW_MODE_STORAGE_KEY);
  return raw === "edit" || raw === "preview" || raw === "split" ? raw : "edit";
}

function DraftBodyPreview({ body, cwd }: { body: string; cwd: string | undefined }) {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return (
      <p className="text-[13px] italic leading-6 text-muted-foreground">
        Zatím není co zobrazit — AI draft se bude streamovat do editoru.
      </p>
    );
  }
  // ChatMarkdown already wraps itself in a `.chat-markdown` div that owns the
  // blog-style typography rules in index.css, so we just pass the raw body
  // through and let the shared stylesheet handle headings, lists, links, etc.
  return <ChatMarkdown text={body} cwd={cwd} />;
}

function BodyViewModeToggle({
  value,
  onChange,
}: {
  value: BodyViewMode;
  onChange: (mode: BodyViewMode) => void;
}) {
  const buttons: Array<{ mode: BodyViewMode; icon: typeof PencilIcon; label: string }> = [
    { mode: "edit", icon: PencilIcon, label: "Editovat" },
    { mode: "preview", icon: EyeIcon, label: "Náhled" },
    { mode: "split", icon: SplitIcon, label: "Rozdělit" },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border/70 bg-background/60 p-0.5">
      {buttons.map(({ mode, icon: Icon, label }) => {
        const active = mode === value;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            title={label}
          >
            <Icon className="size-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

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

function formatModelSelection(
  selection: import("../campaignStore").Campaign["modelSelection"] | undefined,
): string {
  if (!selection) return "—";
  const provider = selection.provider;
  const model = selection.model;
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

function DraftTechnicalInfo({
  campaign,
  draft,
}: {
  campaign: import("../campaignStore").Campaign;
  draft: DraftOutput;
}) {
  const rows = useMemo<Array<[string, string]>>(
    () => [
      ["ID draftu", draft.id],
      ["Kanál", draft.channel],
      ["Status", draft.status],
      ["Poslední změna", formatTimestamp(draft.updatedAt)],
      ["Thread ID", draft.threadRef?.threadId ?? "(nespuštěno)"],
      ["Prostředí", draft.threadRef?.environmentId ?? campaign.environmentId ?? "—"],
      [
        "Model (tento draft)",
        draft.modelOverride
          ? `${formatModelSelection(draft.modelOverride)} (override)`
          : `${formatModelSelection(campaign.modelSelection)} (výchozí pro kampaň)`,
      ],
      ["Model (výchozí kampaně)", formatModelSelection(campaign.modelSelection)],
      ["Projekt", campaign.projectName ?? campaign.projectId ?? "—"],
      ["Cesta projektu", campaign.projectCwd ?? "—"],
      ["Ručně upraveno", draft.bodyIsManuallyEdited ? "ano" : "ne"],
    ],
    [campaign, draft],
  );

  const copyToClipboard = useCallback(() => {
    const text = [
      `Kampaň: ${campaign.name} (${campaign.id})`,
      ...rows.map(([k, v]) => `${k}: ${v}`),
    ].join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      toastManager.add({ type: "success", title: "Thread info zkopírováno do schránky" });
    });
  }, [rows, campaign.id, campaign.name]);

  return (
    <details className="group border-b border-border/70 bg-background/40 text-[12px]">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-6 py-2 text-muted-foreground transition-colors hover:text-foreground">
        <InfoIcon className="size-3.5" />
        <span className="font-medium">Thread info</span>
        <span className="text-[10px] font-normal opacity-70">
          (sdílejte s vývojáři, když něco nefunguje)
        </span>
      </summary>
      <div className="grid gap-x-6 gap-y-1 px-6 pb-3 pt-1 md:grid-cols-2">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-baseline gap-2">
            <span className="w-32 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {key}
            </span>
            <span className="select-text break-all font-mono text-[11.5px] text-foreground/90">
              {value}
            </span>
          </div>
        ))}
        <div className="md:col-span-2">
          <Button size="sm" variant="outline" className="mt-2 gap-1" onClick={copyToClipboard}>
            <ClipboardCopyIcon className="size-3" />
            Zkopírovat info
          </Button>
        </div>
      </div>
    </details>
  );
}

interface CampaignDraftEditorProps {
  campaignId: string;
  channel: string;
}

export function CampaignDraftEditor({ campaignId, channel }: CampaignDraftEditorProps) {
  const navigate = useNavigate();
  const campaign = useCampaignStore((store) => store.getCampaignById(campaignId));
  const draft = useMemo(
    () => campaign?.drafts.find((entry) => entry.channel === channel),
    [campaign, channel],
  );
  const channelConfig = getChannelConfig(channel);

  const draftThreadRef = draft?.threadRef ?? null;
  const draftEnvironmentId = draftThreadRef?.environmentId ?? null;
  const draftThreadId = draftThreadRef?.threadId ?? null;
  const threadSelector = useMemo(
    () =>
      createThreadSelectorByRef(
        draftEnvironmentId && draftThreadId
          ? { environmentId: draftEnvironmentId, threadId: draftThreadId }
          : null,
      ),
    [draftEnvironmentId, draftThreadId],
  );
  const thread = useStore(threadSelector);
  useDraftBodySync(draftThreadRef);

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

  const [editorValue, setEditorValue] = useState<string>(draft?.body ?? "");
  const [localDirty, setLocalDirty] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [bodyViewMode, setBodyViewMode] = useState<BodyViewMode>(readInitialBodyViewMode);

  // Per-draft model selection, seeded from the persisted override, then the
  // campaign default, then the app default. Kept in local state so the user
  // can try different picks in the picker before actually dispatching a run
  // — we only write it back to the store when they click Regenerate (the
  // auto-persist in `campaignCommands` handles that).
  const [activeModelSelection, setActiveModelSelection] = useState<ModelSelection | null>(
    () =>
      draft?.modelOverride ??
      campaign?.modelSelection ??
      (providers.length > 0 ? resolveAppModelSelectionState(settings, providers) : null),
  );

  // When the store-side override changes (e.g. another tab / reset) sync the
  // picker back to it — but don't clobber in-flight picks the user hasn't run
  // yet. We detect "user has in-flight change" by comparing to the last known
  // store value; here we simply refresh from store whenever the draft id or
  // its persisted override changes.
  useEffect(() => {
    if (!draft || !campaign) return;
    const next =
      draft.modelOverride ??
      campaign.modelSelection ??
      (providers.length > 0 ? resolveAppModelSelectionState(settings, providers) : null);
    setActiveModelSelection(next);
    // Only re-run when the draft identity or its stored override changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.modelOverride, campaign?.modelSelection]);
  const handleBodyViewModeChange = useCallback((mode: BodyViewMode) => {
    setBodyViewMode(mode);
    try {
      localStorage.setItem(BODY_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Storage unavailable; the session-scoped preference is still applied.
    }
  }, []);

  useEffect(() => {
    if (!draft) return;
    if (localDirty) return;
    setEditorValue(draft.body);
  }, [draft, localDirty]);

  const latestAssistantText = useMemo(() => {
    if (!thread) return "";
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const message = thread.messages[index];
      if (message && message.role === "assistant") return message.text;
    }
    return "";
  }, [thread]);

  const handleSaveBody = useCallback(() => {
    if (!campaign || !draft) return;
    saveDraftBody(campaign.id, draft.id, editorValue, { status: "draft" });
    setLocalDirty(false);
    toastManager.add({
      type: "success",
      title: "Draft uložen",
      description: "Vaše úpravy jsou uloženy lokálně pro tento draft.",
    });
  }, [campaign, draft, editorValue]);

  const handleRevertToAi = useCallback(() => {
    if (!campaign || !draft) return;
    saveDraftBody(campaign.id, draft.id, latestAssistantText, { status: "draft" });
    setLocalDirty(false);
    setEditorValue(latestAssistantText);
  }, [campaign, draft, latestAssistantText]);

  const handleApprove = useCallback(() => {
    if (!campaign || !draft) return;
    if (localDirty) {
      saveDraftBody(campaign.id, draft.id, editorValue, { status: "approved" });
      setLocalDirty(false);
    } else {
      setDraftStatus(campaign.id, draft.id, "approved");
    }
  }, [campaign, draft, editorValue, localDirty]);

  const handleRequestChanges = useCallback(() => {
    if (!campaign || !draft) return;
    setDraftStatus(campaign.id, draft.id, "review");
  }, [campaign, draft]);

  const handleRegenerate = useCallback(async () => {
    if (!campaign || !draft) return;
    setRegenerating(true);
    try {
      const modelSelection =
        activeModelSelection ?? resolveAppModelSelectionState(settings, providers);
      await regenerateDraft({
        campaignId: campaign.id,
        draftId: draft.id,
        feedback: feedback.trim().length > 0 ? feedback.trim() : null,
        modelSelection,
        projectId: fallbackProjectId,
      });
      setFeedback("");
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Draft se nepodařilo regenerovat",
        description: err instanceof Error ? err.message : "Neznámá chyba.",
      });
    } finally {
      setRegenerating(false);
    }
  }, [activeModelSelection, campaign, draft, feedback, providers, settings, fallbackProjectId]);

  const handleSendFollowUp = useCallback(async () => {
    if (!campaign || !draft) return;
    const trimmed = feedback.trim();
    if (trimmed.length === 0) return;

    try {
      const modelSelection =
        activeModelSelection ?? resolveAppModelSelectionState(settings, providers);
      await sendFollowUpToDraftThread({
        campaignId: campaign.id,
        draftId: draft.id,
        message: trimmed,
        modelSelection,
      });
      setFeedback("");
    } catch (err) {
      toastManager.add({
        type: "error",
        title: "Follow-up se nepodařilo odeslat",
        description: err instanceof Error ? err.message : "Neznámá chyba.",
      });
    }
  }, [activeModelSelection, campaign, draft, feedback, providers, settings]);

  const handleResetModelToCampaignDefault = useCallback(() => {
    if (!campaign || !draft) return;
    const next =
      campaign.modelSelection ??
      (providers.length > 0 ? resolveAppModelSelectionState(settings, providers) : null);
    setActiveModelSelection(next);
    useCampaignStore.getState().updateDraft(campaign.id, draft.id, { modelOverride: null });
  }, [campaign, draft, providers, settings]);

  const handleCopyBody = useCallback(() => {
    void navigator.clipboard.writeText(editorValue).then(() => {
      toastManager.add({ type: "success", title: "Draft zkopírován do schránky" });
    });
  }, [editorValue]);

  if (!campaign || !draft) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-background text-muted-foreground">
        <p className="text-sm">Draft nenalezen.</p>
        <Link to="/" className="mt-2 text-xs text-sky-500 hover:underline">
          Zpět do Content Studia
        </Link>
      </div>
    );
  }

  const isGenerating = draft.status === "generating";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      {!isElectron && (
        <header className="flex items-center gap-2 border-b border-border/70 px-4 py-2 md:hidden">
          <SidebarTrigger className="size-7 shrink-0" />
          <span className="truncate text-sm font-medium">{campaign.name}</span>
        </header>
      )}
      {isElectron && <div className="drag-region h-[52px] shrink-0 border-b border-border/70" />}

      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-6 py-4">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => {
              void navigate({
                to: "/campaigns/$campaignId",
                params: { campaignId: campaign.id },
              });
            }}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3" />
            {campaign.name}
          </button>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            Draft — {channelConfig?.label ?? channel}
          </h1>
          <p className="text-[11px] text-muted-foreground">
            {channelConfig?.format ?? "Výstup draftu"} · {channelConfig?.targetLength ?? ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <DraftStatusBadge status={draft.status} />
          {isGenerating && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] text-sky-600">
              <Loader2Icon className="size-3 animate-spin" />
              Generuji
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={handleCopyBody}
            disabled={editorValue.trim().length === 0}
          >
            <ClipboardCopyIcon className="size-3" />
            Kopírovat
          </Button>
          {draft.status !== "approved" ? (
            <Button size="sm" variant="default" className="gap-1" onClick={handleApprove}>
              <CheckCircle2Icon className="size-3" />
              Označit jako schválený
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="gap-1" onClick={handleRequestChanges}>
              Znovu otevřít k úpravám
            </Button>
          )}
        </div>
      </div>

      <DraftTechnicalInfo campaign={campaign} draft={draft} />

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-border/70 px-6 py-5 lg:border-r">
          <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tělo draftu (markdown)
            </h2>
            <div className="flex items-center gap-2">
              {localDirty && (
                <span className="text-[10px] font-medium text-amber-600">Neuložené změny</span>
              )}
              <BodyViewModeToggle value={bodyViewMode} onChange={handleBodyViewModeChange} />
            </div>
          </div>
          {bodyViewMode === "edit" && (
            <Textarea
              value={editorValue}
              onChange={(event) => {
                setEditorValue(event.target.value);
                setLocalDirty(event.target.value !== draft.body);
              }}
              className="min-h-[200px] flex-1 resize-none font-mono text-[13px] leading-6"
              placeholder="AI draft se sem bude streamovat. Můžete volně upravovat — ruční úpravy zabrání, aby AI přepsala váš text."
            />
          )}
          {bodyViewMode === "preview" && (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border border-border/70 bg-card/40 p-4">
              <DraftBodyPreview body={editorValue} cwd={campaign.projectCwd} />
            </div>
          )}
          {bodyViewMode === "split" && (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 md:grid-cols-2">
              <Textarea
                value={editorValue}
                onChange={(event) => {
                  setEditorValue(event.target.value);
                  setLocalDirty(event.target.value !== draft.body);
                }}
                className="min-h-0 resize-none font-mono text-[13px] leading-6"
                placeholder="AI draft se sem bude streamovat."
              />
              <div className="min-h-0 overflow-y-auto overscroll-contain rounded-md border border-border/70 bg-card/40 p-4">
                <DraftBodyPreview body={editorValue} cwd={campaign.projectCwd} />
              </div>
            </div>
          )}

          <div className="mt-3 flex shrink-0 flex-wrap items-center gap-1.5">
            <Button size="sm" variant="default" onClick={handleSaveBody} disabled={!localDirty}>
              Uložit jako draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRevertToAi}
              disabled={
                latestAssistantText.trim().length === 0 || editorValue === latestAssistantText
              }
              className="gap-1"
            >
              <UndoIcon className="size-3" />
              Vrátit na verzi od AI
            </Button>
          </div>

          {draft.bodyIsManuallyEdited && (
            <p className="mt-2 shrink-0 text-[11px] text-amber-600">
              Tento draft je ručně upravený. AI ho svými budoucími odpověďmi nepřepíše, dokud ho
              nevrátíte nebo nenecháte regenerovat.
            </p>
          )}
        </section>

        <section className="flex min-h-0 min-w-0 flex-col px-6 py-5">
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <h2 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <SparklesIcon className="size-3 text-sky-500" />
              Pracovní kopie AI
            </h2>
            {thread?.id && draftThreadRef && (
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: draftThreadRef.environmentId,
                  threadId: thread.id,
                }}
                className="text-[11px] text-sky-500 hover:underline"
              >
                Otevřít celou konverzaci
              </Link>
            )}
          </div>

          <div className="min-h-[200px] min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-border/70 bg-card/60 p-4">
            {latestAssistantText.trim().length === 0 ? (
              <p className="text-[13px] italic leading-6 text-muted-foreground">
                Provider zatím neodpověděl. Spusťte regeneraci níže, nebo přidejte feedback.
              </p>
            ) : (
              <DraftBodyPreview body={latestAssistantText} cwd={campaign.projectCwd} />
            )}
          </div>

          <div className="mt-4 shrink-0 space-y-2 rounded-xl border border-border/70 bg-background/60 p-3">
            <label htmlFor="draft-feedback" className="text-[11px] font-semibold">
              Feedback / follow-up
            </label>
            <textarea
              id="draft-feedback"
              rows={3}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              placeholder="Kratší prosím, začni výsledkem… nebo jakákoli jiná změna pro další běh."
            />
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">Model:</span>
              {activeModelSelection ? (
                <CampaignModelPicker
                  value={activeModelSelection}
                  onChange={setActiveModelSelection}
                  compact
                  disabled={regenerating}
                />
              ) : (
                <span className="italic text-muted-foreground">Načítám providery…</span>
              )}
              {draft.modelOverride && (
                <button
                  type="button"
                  onClick={handleResetModelToCampaignDefault}
                  className="text-[10px] text-muted-foreground underline hover:text-foreground"
                  title="Zrušit model pro tento draft a při dalším běhu použít výchozí model kampaně."
                >
                  Obnovit výchozí model kampaně
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="default"
                className="gap-1"
                onClick={() => void handleRegenerate()}
                disabled={regenerating}
              >
                {regenerating ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
                {regenerating
                  ? "Regeneruji…"
                  : feedback.trim().length > 0
                    ? "Regenerovat s feedbackem"
                    : "Regenerovat od začátku"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={() => void handleSendFollowUp()}
                disabled={feedback.trim().length === 0 || !draft.threadRef}
              >
                <SendIcon className="size-3" />
                Požádat o úpravu
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              „Požádat o úpravu" pošle feedback jako další zprávu ve stejné konverzaci. Regenerace
              vyžádá čistý nový draft s aplikovaným feedbackem. Výběr modelu zde se pamatuje pro
              tento draft, dokud ho neobnovíte.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
