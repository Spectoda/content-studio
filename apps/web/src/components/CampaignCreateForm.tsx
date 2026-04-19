/**
 * CampaignCreateForm — intake form for starting a new campaign.
 *
 * Collects the minimum input Anička needs: name, brief, working prompt, and
 * selected channels. Submitting the form creates one provider thread per
 * channel and navigates to the new campaign workspace.
 */

import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ModelSelection, ProjectId } from "@t3tools/contracts";

import { CAMPAIGN_CHANNELS, type ChannelId } from "../campaignChannels";
import { createCampaign } from "../campaignCommands";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { resolveAppModelSelectionState } from "../modelSelection";
import { useServerProviders } from "../rpc/serverState";
import { useSettings } from "../hooks/useSettings";
import { selectProjectByRef, selectProjectsForEnvironment, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { CampaignModelPicker } from "./CampaignModelPicker";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const WORKING_PROMPT_STARTERS = [
  "Napiš jeden silný draft na každý kanál. Drž se prakticky, konkrétně a v duchu Spectody — žádný AI slop.",
  "Začni výsledkem pro zákazníka, ukaž konkrétní důkaz, technologii vysvětli až nakonec.",
  "Zachovej tón našich posledních launchů: vřelý, sebevědomý, produktově vedený.",
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
    const ordered = projectOrder.filter((id): id is ProjectId =>
      projectIdSet.has(id),
    ) as ProjectId[];
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

  // Per-campaign model selection, seeded from the app default once providers
  // are loaded. If the user picks a different model/effort combination here,
  // it's captured on the `Campaign.modelSelection` snapshot so every future
  // regeneration of any draft in this campaign uses that as the fallback
  // (unless the draft itself has a per-draft override).
  //
  // Local state (not resolved on every render) so we don't clobber a user's
  // pick on re-renders triggered by unrelated settings or provider polling.
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  useEffect(() => {
    if (modelSelection !== null) return;
    if (providers.length === 0) return;
    setModelSelection(resolveAppModelSelectionState(settings, providers));
  }, [modelSelection, providers, settings]);

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
      // Prefer the user's picked model; fall back to the app default resolve
      // (handles the "providers loaded right before submit" race).
      const resolvedModelSelection =
        modelSelection ?? resolveAppModelSelectionState(settings, providers);
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
        modelSelection: resolvedModelSelection,
      });

      if (dispatchErrors.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Některé drafty se nepodařilo spustit",
          description: dispatchErrors.map((entry) => `${entry.channel}: ${entry.error}`).join("\n"),
        });
      }

      onCreated?.(campaign.id);
      await navigate({
        to: "/campaigns/$campaignId",
        params: { campaignId: campaign.id },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kampaň se nepodařilo vytvořit.");
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
            Spusťte kampaň, ne chat.
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Pojmenujte kampaň, popište nápad, vyberte pracovní prompt a zvolte kanály, pro které
            potřebujete drafty. Content Studio otevře workspace s jedním draftem na každý kanál, aby
            se každý výstup dal zkontrolovat a ladit samostatně.
          </p>
        </header>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-4">
          <div>
            <label htmlFor="campaign-name" className="mb-1.5 block text-xs font-semibold">
              Název kampaně
            </label>
            <input
              id="campaign-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              placeholder="Jarní launch Spectoda Studia"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="campaign-brief" className="mb-1.5 block text-xs font-semibold">
              Brief kampaně
            </label>
            <textarea
              id="campaign-brief"
              rows={6}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              className="w-full resize-y rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              placeholder="Co oznamujeme, proč teď, pro koho to je a jaké důkazy by měl každý kanál zdůraznit?"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Pište stručně. Brief se použije pro prompt každého kanálu, takže ho napište jednou a
              jasně.
            </p>
          </div>

          <div>
            <label htmlFor="campaign-working-prompt" className="mb-1.5 block text-xs font-semibold">
              Pracovní prompt
            </label>
            <textarea
              id="campaign-working-prompt"
              rows={4}
              value={workingPrompt}
              onChange={(event) => setWorkingPrompt(event.target.value)}
              className="w-full resize-y rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/25"
              placeholder="Jak mají drafty působit? Jaký tón, strukturu a priority má AI sledovat?"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {WORKING_PROMPT_STARTERS.map((starter, index) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => setWorkingPrompt(starter)}
                  className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-sky-500/50 hover:text-foreground"
                >
                  Vzor {index + 1}
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside className="space-y-4 rounded-2xl border border-border/70 bg-background/60 p-4">
          <div>
            <p className="text-xs font-semibold">Cílové kanály</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              Každý vybraný kanál dostane vlastní draft, který můžete samostatně schválit nebo
              regenerovat.
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

          <div className="space-y-2">
            <p className="text-xs font-semibold">Výchozí model</p>
            <p className="text-[11px] leading-5 text-muted-foreground">
              Výchozí provider a model pro všechny drafty v této kampani. U každého draftu to jde
              pak přebít vlastním výběrem.
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {modelSelection ? (
                <CampaignModelPicker
                  value={modelSelection}
                  onChange={setModelSelection}
                  compact
                  disabled={submitting}
                />
              ) : (
                <span className="text-[11px] italic text-muted-foreground">
                  Načítám providery…
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-border/70 bg-card/80 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <SparklesIcon className="size-3.5 text-sky-500" />
              Jak to funguje
            </div>
            <ol className="space-y-1 text-[11px] leading-5 text-muted-foreground">
              <li>1. Pro tuto kampaň otevřeme workspace.</li>
              <li>2. Pro každý vybraný kanál se spustí jedna AI konverzace.</li>
              <li>3. Každý draft si nezávisle zkontrolujete, upravíte nebo necháte regenerovat.</li>
            </ol>
          </div>

          <Button type="submit" className="w-full gap-2" disabled={!canSubmit || submitting}>
            {submitting ? "Otevírám workspace…" : "Otevřít workspace kampaně"}
            <ArrowRightIcon className="size-4" />
          </Button>

          {!environmentId && (
            <p className="text-[11px] text-amber-600">
              Žádné prostředí ještě není aktivní. Počkejte, až se Content Studio připojí k serveru.
            </p>
          )}

          {environmentId && !defaultProjectId && (
            <p className="text-[11px] text-amber-600">
              Ještě není dostupný žádný projekt. Ujistěte se, že Content Studio vidí alespoň jeden
              projekt, než kampaň založíte.
            </p>
          )}

          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </aside>
      </div>
    </form>
  );
}
