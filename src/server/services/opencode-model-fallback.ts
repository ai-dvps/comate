/**
 * opencode-model-fallback — transparent compatibility for claude-code model
 * alias conventions (e.g. `glm-5.2[1m]`, `k3[1m]`). Some endpoints accept the
 * `[...]` context-variant alias (Kimi), others reject it with model-not-found
 * (Zhipu) while accepting the base id. The user must never need a per-backend
 * provider config: the first attempt goes out as configured, and only a
 * model-not-found error on a suffixed id triggers a silent retry with the
 * base id.
 */

const MODEL_NOT_FOUND_RE =
  /1211|模型不存在|model\s*(?:does\s*not\s*exist|not\s*found|unknown|invalid)|unknown\s*model|no\s*such\s*model/i;

const MODEL_SUFFIX_RE = /\[[^\]]+\]$/;

export function isModelNotFoundError(message: string): boolean {
  return MODEL_NOT_FOUND_RE.test(message);
}

/** Strip a trailing `[...]` alias suffix (`glm-5.2[1m]` -> `glm-5.2`). */
export function stripModelSuffix(modelID: string): string {
  return modelID.replace(MODEL_SUFFIX_RE, '');
}

export interface ModelFallbackDecision {
  action: 'retry' | 'forward';
  /** Wire id to retry with when action is 'retry'. */
  wireModelID?: string;
}

/**
 * Decide whether a session.error should be swallowed-and-retried with the
 * base model id (transparent compatibility) or forwarded as a visible error.
 * Retry at most once per resolution: an error after the wire id was already
 * resolved is forwarded.
 */
export function decideModelFallback(
  errorMessage: string,
  modelID: string,
  alreadyResolved: boolean,
): ModelFallbackDecision {
  if (alreadyResolved) return { action: 'forward' };
  if (!MODEL_SUFFIX_RE.test(modelID)) return { action: 'forward' };
  if (!isModelNotFoundError(errorMessage)) return { action: 'forward' };
  return { action: 'retry', wireModelID: stripModelSuffix(modelID) };
}

/** Register both the configured alias and its base form in the serve config
 * models map, so a fallback retry never hits an unregistered model ref. */
export function expandModelAliases(modelID: string): Record<string, { name: string }> {
  const base = stripModelSuffix(modelID);
  if (base === modelID) return { [modelID]: { name: modelID } };
  return {
    [modelID]: { name: modelID },
    [base]: { name: base },
  };
}
