/**
 * Diagnostic event shim.
 *
 * In core OpenClaw this dispatches to the diagnostics subsystem.
 * As a plugin we emit events via the plugin logger or silently ignore
 * when diagnostics are unavailable.
 */

import {
  getDiagnosticEmitterPort,
  setDiagnosticEmitterPort,
} from "./runtime/integrations.js";

type DiagnosticPayload = Record<string, unknown>;

export function setDiagnosticEmitter(fn: (payload: DiagnosticPayload) => void): void {
  setDiagnosticEmitterPort(fn);
}

export function emitDiagnosticEvent(payload: DiagnosticPayload): void {
  const emitter = getDiagnosticEmitterPort();
  emitter?.(payload);
}

/**
 * Log an error through diagnostics without throwing.
 * Used to upgrade bare catch {} blocks in critical paths.
 */
export function safeLog(context: string, err: unknown): void {
  try {
    emitDiagnosticEvent({
      type: "internal_error",
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch {
    // Last resort: don't recurse
  }
}
