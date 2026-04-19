/**
 * Clawforce — Codex executor config types
 *
 * Configuration shape for the direct Codex CLI executor.
 */

export type CodexConfig = {
  /** Path to the codex CLI binary (default: "codex"). */
  binary?: string;
  /** OpenAI model to use for dispatches (default: "gpt-5.4"). */
  model?: string;
  /** Working directory for codex CLI invocations. */
  workdir?: string;
  /** Approval policy passed to codex exec for direct runs. */
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
  /** Sandbox mode passed to codex exec when not using full-auto. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Additional explicitly allowed workspace roots. */
  addDirs?: string[];
  /** Use Codex full-auto mode for unattended execution (default: true). */
  fullAuto?: boolean;
  /** Skip repo checks for generated or detached project dirs (default: true). */
  skipGitRepoCheck?: boolean;
  /**
   * Bypass Codex approvals and sandbox entirely.
   * Keep this opt-in; it is stronger than the default full-auto flow.
   */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Internal per-invocation config overrides passed through `codex exec -c`. */
  configOverrides?: string[];
};

export const CODEX_DEFAULTS: Required<Omit<CodexConfig, "workdir" | "configOverrides" | "approvalPolicy" | "addDirs">> = {
  binary: "codex",
  model: "gpt-5.4",
  sandbox: "workspace-write",
  fullAuto: true,
  skipGitRepoCheck: true,
  dangerouslyBypassApprovalsAndSandbox: false,
};

export function normalizeCodexModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("openai-codex/")) {
    const normalized = trimmed.slice("openai-codex/".length).trim();
    return normalized || trimmed;
  }

  if (trimmed.startsWith("openai/")) {
    const normalized = trimmed.slice("openai/".length).trim();
    return normalized || trimmed;
  }

  return trimmed;
}

export function resolveCodexConfig(
  raw?: Partial<CodexConfig>,
): Required<Omit<CodexConfig, "workdir" | "configOverrides" | "approvalPolicy" | "addDirs">>
  & Pick<CodexConfig, "workdir" | "configOverrides" | "approvalPolicy" | "addDirs"> {
  return {
    binary: raw?.binary ?? CODEX_DEFAULTS.binary,
    model: normalizeCodexModel(raw?.model) ?? CODEX_DEFAULTS.model,
    sandbox: raw?.sandbox ?? CODEX_DEFAULTS.sandbox,
    fullAuto: raw?.fullAuto ?? CODEX_DEFAULTS.fullAuto,
    skipGitRepoCheck: raw?.skipGitRepoCheck ?? CODEX_DEFAULTS.skipGitRepoCheck,
    dangerouslyBypassApprovalsAndSandbox:
      raw?.dangerouslyBypassApprovalsAndSandbox
      ?? CODEX_DEFAULTS.dangerouslyBypassApprovalsAndSandbox,
    workdir: raw?.workdir,
    approvalPolicy: raw?.approvalPolicy,
    addDirs: raw?.addDirs ?? [],
    configOverrides: raw?.configOverrides ?? [],
  };
}

export function validateCodexConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (config === null || config === undefined) {
    return errors;
  }

  if (typeof config !== "object" || Array.isArray(config)) {
    errors.push("codex config must be an object");
    return errors;
  }

  const c = config as Record<string, unknown>;

  if (c.binary !== undefined && typeof c.binary !== "string") {
    errors.push("codex.binary must be a string");
  }
  if (c.model !== undefined && typeof c.model !== "string") {
    errors.push("codex.model must be a string");
  }
  if (c.workdir !== undefined && typeof c.workdir !== "string") {
    errors.push("codex.workdir must be a string");
  }
  if (c.approvalPolicy !== undefined) {
    const valid = ["untrusted", "on-request", "on-failure", "never"];
    if (typeof c.approvalPolicy !== "string" || !valid.includes(c.approvalPolicy)) {
      errors.push(`codex.approvalPolicy must be one of: ${valid.join(", ")}`);
    }
  }
  if (c.sandbox !== undefined) {
    const valid = ["read-only", "workspace-write", "danger-full-access"];
    if (typeof c.sandbox !== "string" || !valid.includes(c.sandbox)) {
      errors.push(`codex.sandbox must be one of: ${valid.join(", ")}`);
    }
  }
  if (c.addDirs !== undefined) {
    if (!Array.isArray(c.addDirs) || c.addDirs.some((value) => typeof value !== "string")) {
      errors.push("codex.addDirs must be an array of strings");
    }
  }
  if (c.fullAuto !== undefined && typeof c.fullAuto !== "boolean") {
    errors.push("codex.fullAuto must be a boolean");
  }
  if (c.skipGitRepoCheck !== undefined && typeof c.skipGitRepoCheck !== "boolean") {
    errors.push("codex.skipGitRepoCheck must be a boolean");
  }
  if (
    c.dangerouslyBypassApprovalsAndSandbox !== undefined
    && typeof c.dangerouslyBypassApprovalsAndSandbox !== "boolean"
  ) {
    errors.push("codex.dangerouslyBypassApprovalsAndSandbox must be a boolean");
  }
  if (c.configOverrides !== undefined) {
    if (!Array.isArray(c.configOverrides) || c.configOverrides.some((value) => typeof value !== "string")) {
      errors.push("codex.configOverrides must be an array of strings");
    }
  }

  return errors;
}
