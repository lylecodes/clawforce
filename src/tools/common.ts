/**
 * Clawforce — Tool helpers
 *
 * Shared param readers and result formatters for agent tools.
 * Uses core AgentToolResult format (content array) to match plugin SDK expectations.
 */

/** Tool result matching the pi-agent-core AgentToolResult shape. */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

/** Return a JSON text result from a tool. */
export function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: null,
  };
}

/**
 * Adapt our tool shape to AnyAgentTool.
 * Centralizes the single cast needed for cross-package type compatibility.
 * Our ToolResult is structurally identical to AgentToolResult<unknown>,
 * but TypeScript can't verify this across package boundaries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptTool(tool: { label: string; name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<ToolResult> }): any {
  return tool;
}

/** Read a string parameter, optionally required. */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean },
): string | null {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    if (opts?.required) throw new Error(`Missing required parameter: ${key}`);
    return null;
  }
  return String(value);
}

/** Read a number parameter. */
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { integer?: boolean },
): number | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  if (opts?.integer) return Math.round(num);
  return num;
}

/** Return a standardized error result from a tool. */
export function errorResult(reason: string): ToolResult {
  return jsonResult({ ok: false, reason });
}

/**
 * Wrap a tool execute body to catch thrown errors (e.g. from readStringParam required checks)
 * and return them as structured error results instead of propagating exceptions.
 */
export async function safeExecute(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(message);
  }
}

/** Read a boolean parameter, handling string "true"/"false" and native booleans. */
export function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  const str = String(value).toLowerCase();
  if (str === "true" || str === "1") return true;
  if (str === "false" || str === "0") return false;
  return null;
}

/**
 * Resolve project ID with cross-project access protection.
 * If a bound projectId exists (from tool creation), it takes precedence.
 * Callers can still pass project_id but it must match the bound value.
 */
export function resolveProjectId(
  params: Record<string, unknown>,
  boundProjectId: string | undefined,
  fallback = "default",
): { projectId: string; error?: never } | { projectId?: never; error: string } {
  const callerProjectId = readStringParam(params, "project_id");
  if (boundProjectId) {
    if (callerProjectId && callerProjectId !== boundProjectId) {
      return { error: `Cross-project access denied: this session is bound to project "${boundProjectId}".` };
    }
    return { projectId: boundProjectId };
  }
  return { projectId: callerProjectId ?? fallback };
}

/** Read a string array parameter. */
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): string[] | null {
  const value = params[key];
  if (!Array.isArray(value)) return null;
  return value.map(String);
}
