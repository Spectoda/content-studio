/**
 * CampaignCreateForm — intake form for starting a new campaign.
 *
 * Collects the minimum input Anička needs: name, brief, working prompt, and
 * selected channels. Submitting the form creates one provider thread per
 * channel and navigates to the new campaign workspace.
 */

import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ProjectId } from "@t3tools/contracts";

import { CAMPAIGN_CHANNELS, type ChannelId } from "../campaignChannels";
import { createCampaign } from "../campaignCommands";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerProviders } from "../rpc/serverState";
import { useSettings } from "../hooks/useSettings";
import { selectProjectByRef, selectProjectsForEnvironment, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const WORKING_PROMPT_STARTERS = [
  "Write one strong draft per channel. Stay practical, concrete, and Spectoda-flavoured — no AI slop.",
  "Lead with the customer outcome, show the proof point, explain the tech last.",
  "Match the tone of our latest launches: warm, confident, product-led.",
];

const DEFAULT_CHANNELS: ChannelId[] = ["linkedin", "newsletter"];

interface CampaignCreateFormProps {
  variant?: "hero" | "inline";
  onCreated?: (campaignId: string) => void;
}

export function CampaignCreateForm({ variant = "hero", onCreated }: CampaignCreateFormProps) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const projectIds = useStore(
    useShallow((store) =>
      selectProjectsForEnvironment(store, environmentId).map((project) => project.id),
    ),
  );
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const providers = useServerProviders();
  const settings = useSettings();
  const orderedProjectIds = useMemo<ProjectId[]>(() => {
    if (projectOrder.length === 0) return projectIds;
    const projectIdSet = new Set<string>(projectIds);
    const ordered = projectOrder.filter((id): id is ProjectId => projectIdSet.has(id)) as ProjectId[];
    const remaining = projectIds.filter((id) => !projectOrder.includes(id));
    return [...ordered, ...remaining];
  }, [projectIds, projectOrder]);
  const defaultProjectId: ProjectId | null = orderedProjectIds[0] ?? null;

  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [workingPrompt, setWorkingPrompt] = useState<string>(WORKING_PROMPT_STARTERS[0] ?? "");
  const [selectedChannels, setSelectedChannels] = useState<ChannelId[]>(DEFAULT_CHANNELS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const canSubmit =
    trimmedName.length > 0 &&
    brief.trim().length > 0 &&
    selectedChannels.length > 0 &&
    defaultProjectId !== null &&
    environmentId !== null;

  const toggleChannel = (id: ChannelId) => {
    setSelectedChannels((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id],
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit || !defaultProjectId || !environmentId) return;
    setSubmitting(true);
    setError(null);

    try {
      const modelSelection = resolveAppModelSelectionState(settings, providers);
      // Resolve project display metadata at submit time so the campaign gets a
      // troubleshooting snapshot of "which project / cwd ran this" that
      // survives even if the project is renamed or removed later.
      const project = selectProjectByRef(useStore.getState(), {
        environmentId,
        projectId: defaultProjectId,
      });
      const { campaign, dispatchErrors } = await createCampaign({
        environmentId,
        name: trimmedName,
        brief: brief.trim(),
        workingPrompt: workingPrompt.trim(),
        selectedChannels,
        projectId: defaultProjectId,
        ...(project?.name ? { projectName: project.name } : {}),
        ...(project?.cwd ? { projectCwd: project.cwd } : {}),
        modelSelection,
      });

      if (dispatchErrors.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some drafts failed to start",
          description: dispatchErrors.map((entry) => `${entry.channel}: ${entry.error}`).join("\n"),
        });
      }

      onCreated?.(campaign.id);
      await navigate({
        to: "/campaigns/$campaignId",
        params: { campaignId: campaign.id },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign.");
    } finally {
      setSubmitting(false);
    }
  };

  const hero = variant === "hero";

  return (
    <form
      className={hero ? "flex w-full flex-col gap-6" : "flex w-full flex-col gap-4"}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      {hero && (
        <header className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-600">
            Content Studio
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Start a campaign, not a chat.
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Name your campaign, describe the idea, pick a working prompt, and choose the channels
            you need drafts for. Content Studio opens a workspace with one draft per channel so each
            output can be reviewed and iterated on its own.
          </p>
        </header>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-4">
          <div>
            <label htmlFor="campaign-name" className="mb-1.5 block text-xs font-semibold">
              Campaign name
            </label>
            <input
              id="campaign-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              placeholder="Spring launch for Spectoda Studio"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="campaign-brief" className="mb-1.5 block text-xs font-semibold">
              Campaign brief
            </label>
            <textarea
              id="campaign-brief"
              rows={6}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              className="w-full resize-y rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              placeholder="What are we announcing, why now, who is it for, and which proof points should every channel emphasise?"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Keep it short. The brief is reused for every channel's prompt, so write it once,
              clearly.
            </p>
          </div>

          <div>
            <label htmlFor="campaign-working-prompt" className="mb-1.5 block text-xs font-semibold">
              Working prompt
            </label>
            <textarea
              id="campaign-working-prompt"
              rows={4}
              value={workingPrompt}
              onChange={(event) => setWorkingPrompt(event.target.value)}
              className="w-full resize-y rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              placeholder="How should the drafts feel? What tone, structure, and priorities should the AI lean into?"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {WORKING_PROMPT_STARTERS.map((starter, index) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => setWorkingPrompt(starter)}
                  className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-sky-500/50 hover:text-foreground"
                >
                  Starter {index + 1}
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside className="space-y-4 rounded-2xl border border-border/70 bg-background/60 p-4">
          <div>
            <p className="text-xs font-semibold">Target channels</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              Each selected channel gets its own draft that you can approve or regenerate
              separately.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {CAMPAIGN_CHANNELS.map((channel) => {
              const active = selectedChannels.includes(channel.id);
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => toggleChannel(channel.id)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                    active
                      ? "border-sky-500 bg-sky-500/15 text-sky-700 dark:text-sky-300"
                      : "border-border bg-card text-muted-foreground hover:border-sky-500/40 hover:text-foreground"
                  }`}
                >
                  {channel.label}
                </button>
              );
            })}
          </div>

          <div className="space-y-2 rounded-xl border border-border/70 bg-card/80 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <SparklesIcon className="size-3.5 text-sky-500" />
              How this works
            </div>
            <ol className="space-y-1 text-[11px] leading-5 text-muted-foreground">
              <li>1. We open a workspace for this campaign.</li>
              <li>2. One AI thread is started per selected channel.</li>
              <li>3. You review, tweak, or regenerate each draft independently.</li>
            </ol>
          </div>

          <Button type="submit" className="w-full gap-2" disabled={!canSubmit || submitting}>
            {submitting ? "Opening workspace..." : "Open campaign workspace"}
            <ArrowRightIcon className="size-4" />
          </Button>

          {!environmentId && (
            <p className="text-[11px] text-amber-600">
              No environment is active yet. Wait for Content Studio to connect to a server.
            </p>
          )}

          {environmentId && !defaultProjectId && (
            <p className="text-[11px] text-amber-600">
              No project is available yet. Make sure Content Studio can see a project before
              creating a campaign.
            </p>
          )}

          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </aside>
      </div>
    </form>
  );
}
