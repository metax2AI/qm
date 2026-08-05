import {
  DEFAULT_WEBUI_MODEL_IDS,
  THINKING_LEVELS,
  serviceableModelIds,
  modelServiceable,
  resolveModel,
  ALL_PROVIDERS_AVAILABLE,
  type ModelProviderAvailability,
} from "../model/pi-models.ts";

export const NON_INTERACTIVE_THINKING_LEVEL = "xhigh";
export const NON_INTERACTIVE_FAST_MODE = false;

export interface WebTurnOptionRefusal {
  reason: string;
  reasonCode: "effort_not_supported" | "model_not_enabled" | "model_provider_unavailable";
}

export function resolveTurnFastMode(
  requested: boolean | undefined,
  humanTurn: boolean,
  interactiveDefault: boolean,
): boolean | undefined {
  if (typeof requested === "boolean") return requested;
  return humanTurn && interactiveDefault ? true : undefined;
}

export function turnModelOptions(input: { triggered?: boolean; thinkingLevel?: string; fastMode?: boolean }): {
  thinkingLevel?: string;
  fastMode?: boolean;
} {
  let thinkingLevel = input.thinkingLevel;
  if (!thinkingLevel && input.triggered) thinkingLevel = NON_INTERACTIVE_THINKING_LEVEL;
  let fastMode = input.fastMode;
  if (typeof fastMode !== "boolean" && input.triggered) fastMode = NON_INTERACTIVE_FAST_MODE;
  return {
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

export function webTurnRuntimeModelRefusal(
  runtimeModelId: string,
  orgModelId: string,
  configuredWebuiModels: readonly string[] | null | undefined,
): WebTurnOptionRefusal | null {
  if (!configuredWebuiModels?.length) return null;
  if (runtimeModelId === orgModelId) return null;
  return configuredWebuiModels.includes(runtimeModelId)
    ? null
    : { reason: "that model is not enabled for the web UI", reasonCode: "model_not_enabled" };
}

export function validateWebTurnModelOptions(
  input: { model?: string; thinkingLevel?: string },
  enabledModels: readonly string[] | null,
  providers: ModelProviderAvailability = ALL_PROVIDERS_AVAILABLE,
): WebTurnOptionRefusal | null {
  const enabled = enabledModels?.length ? enabledModels : DEFAULT_WEBUI_MODEL_IDS;
  const allowedModels = serviceableModelIds(enabled, providers);
  if (input.model && !allowedModels.includes(input.model)) {
    return resolveModel(input.model) && !modelServiceable(input.model, providers)
      ? {
          reason: "that model isn't available on this deployment (its provider isn't configured)",
          reasonCode: "model_provider_unavailable",
        }
      : { reason: "that model is not enabled for the web UI", reasonCode: "model_not_enabled" };
  }
  if (input.thinkingLevel && !(THINKING_LEVELS as readonly string[]).includes(input.thinkingLevel))
    return { reason: "unsupported thinking level", reasonCode: "effort_not_supported" };
  return null;
}
