/**
 * CampaignModelPicker — provider/model + traits dropdown tailored for the
 * Campaign UI.
 *
 * Thin wrapper around the generic `ProviderModelPicker` and `TraitsPicker`
 * that already live under `components/chat`. We reuse their menu popups +
 * styling so the Campaign surface feels consistent with the main chat
 * composer, while hiding the per-provider model-options reduce from every
 * call site (DraftEditor, DraftCard, …).
 *
 * The TraitsPicker surfaces whatever the current provider/model exposes —
 * reasoning effort (Low/Medium/High), thinking toggle, fast mode, context
 * window, OpenCode variant / agent. It auto-hides when a model has no
 * controls (nothing to configure).
 *
 * Cross-provider model switches intentionally drop the previous provider's
 * options because the option shape is different on each provider —
 * `createModelSelection` would otherwise carry incompatible fields through
 * the discriminated union.
 */

import { memo, useMemo } from "react";
import type {
  ModelSelection,
  ProviderKind,
  ProviderModelOptions,
  ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { useServerProviders } from "../rpc/serverState";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { TraitsPicker } from "./chat/TraitsPicker";

type ProviderOptions = ProviderModelOptions[ProviderKind];

export const CampaignModelPicker = memo(function CampaignModelPicker(props: {
  value: ModelSelection;
  onChange: (next: ModelSelection) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const providers = useServerProviders();
  const modelOptionsByProvider = useMemo<
    Record<ProviderKind, ReadonlyArray<ServerProvider["models"][number]>>
  >(
    () => ({
      codex: providers.find((provider) => provider.provider === "codex")?.models ?? [],
      claudeAgent:
        providers.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
      opencode: providers.find((provider) => provider.provider === "opencode")?.models ?? [],
      cursor: providers.find((provider) => provider.provider === "cursor")?.models ?? [],
    }),
    [providers],
  );

  const activeProviderModels = useMemo(
    () => modelOptionsByProvider[props.value.provider],
    [modelOptionsByProvider, props.value.provider],
  );

  return (
    <div className="inline-flex items-center gap-1">
      <ProviderModelPicker
        provider={props.value.provider}
        model={props.value.model}
        lockedProvider={null}
        providers={providers}
        modelOptionsByProvider={modelOptionsByProvider}
        {...(props.compact !== undefined ? { compact: props.compact } : {})}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
        triggerVariant="outline"
        onProviderModelChange={(provider, model) => {
          // Same provider: preserve `options` (effort/thinking/fast) because
          // the option shape is compatible. Cross-provider: drop them — each
          // provider's options are a different discriminant and mixing them
          // would pass a structurally invalid payload through
          // `createModelSelection`.
          if (provider === props.value.provider) {
            props.onChange(createModelSelection(provider, model, props.value.options));
          } else {
            props.onChange(createModelSelection(provider, model));
          }
        }}
      />
      <TraitsPicker
        provider={props.value.provider}
        models={activeProviderModels}
        model={props.value.model}
        // Campaign picker is a standalone dropdown — no composer prompt to
        // reach into, so ultrathink-in-prompt branch is disabled. Traits are
        // persisted purely through the `options` payload on ModelSelection.
        prompt=""
        onPromptChange={() => {}}
        allowPromptInjectedEffort={false}
        modelOptions={props.value.options as ProviderOptions | undefined}
        triggerVariant="outline"
        onModelOptionsChange={(nextOptions) => {
          props.onChange(
            createModelSelection(props.value.provider, props.value.model, nextOptions),
          );
        }}
      />
    </div>
  );
});
