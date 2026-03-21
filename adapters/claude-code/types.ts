/**
 * Clawforce — Claude Code adapter config types
 *
 * Configuration shape for the Claude Code adapter.
 * Controls how ClawForce spawns and manages Claude Code CLI processes.
 */

/**
 * Claude Code adapter configuration.
 * Passed via `claude_code` key in global config or per-agent overrides.
 */
export type ClaudeCodeConfig = {
  /** Path to the claude CLI binary (default: "claude"). */
  binary?: string;
  /** Model to use for dispatches (default: "claude-opus-4-6"). */
  model?: string;
  /** Working directory for claude CLI invocations. */
  workdir?: string;
  /** Permission mode for tool usage (default: "auto"). */
  permissionMode?: string;
  /** Max spend per dispatch in dollars (default: 1.00). */
  maxBudgetPerDispatch?: number;
  /** Path to MCP server config JSON for claude CLI. */
  mcpConfigPath?: string;
};

/** Defaults applied when config values are not provided. */
export const CLAUDE_CODE_DEFAULTS: Required<Omit<ClaudeCodeConfig, "workdir" | "mcpConfigPath">> = {
  binary: "claude",
  model: "claude-opus-4-6",
  permissionMode: "auto",
  maxBudgetPerDispatch: 1.0,
};

/**
 * Resolve a partial ClaudeCodeConfig into a fully populated config
 * with defaults applied for missing fields.
 */
export function resolveClaudeCodeConfig(
  raw?: Partial<ClaudeCodeConfig>,
): Required<Omit<ClaudeCodeConfig, "workdir" | "mcpConfigPath">> & Pick<ClaudeCodeConfig, "workdir" | "mcpConfigPath"> {
  return {
    binary: raw?.binary ?? CLAUDE_CODE_DEFAULTS.binary,
    model: raw?.model ?? CLAUDE_CODE_DEFAULTS.model,
    permissionMode: raw?.permissionMode ?? CLAUDE_CODE_DEFAULTS.permissionMode,
    maxBudgetPerDispatch: raw?.maxBudgetPerDispatch ?? CLAUDE_CODE_DEFAULTS.maxBudgetPerDispatch,
    workdir: raw?.workdir,
    mcpConfigPath: raw?.mcpConfigPath,
  };
}

/**
 * Validate a ClaudeCodeConfig, returning an array of error strings.
 * Empty array means the config is valid.
 */
export function validateClaudeCodeConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (config === null || config === undefined) {
    return errors; // undefined/null config is valid (defaults will be used)
  }

  if (typeof config !== "object" || Array.isArray(config)) {
    errors.push("claude_code config must be an object");
    return errors;
  }

  const c = config as Record<string, unknown>;

  if (c.binary !== undefined && typeof c.binary !== "string") {
    errors.push("claude_code.binary must be a string");
  }
  if (c.model !== undefined && typeof c.model !== "string") {
    errors.push("claude_code.model must be a string");
  }
  if (c.workdir !== undefined && typeof c.workdir !== "string") {
    errors.push("claude_code.workdir must be a string");
  }
  if (c.permissionMode !== undefined && typeof c.permissionMode !== "string") {
    errors.push("claude_code.permissionMode must be a string");
  }
  if (c.maxBudgetPerDispatch !== undefined) {
    if (typeof c.maxBudgetPerDispatch !== "number" || c.maxBudgetPerDispatch < 0) {
      errors.push("claude_code.maxBudgetPerDispatch must be a non-negative number");
    }
  }
  if (c.mcpConfigPath !== undefined && typeof c.mcpConfigPath !== "string") {
    errors.push("claude_code.mcpConfigPath must be a string");
  }

  return errors;
}
