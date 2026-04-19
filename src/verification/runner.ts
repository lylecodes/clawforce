/**
 * Clawforce — Verification gate runner
 *
 * Executes configured verification commands (tests, typecheck, lint)
 * and returns structured results for use in lifecycle transitions.
 */

import { execSync } from "node:child_process";
import { evaluateCommandExecution } from "../execution/intercept.js";
import type { DomainExecutionEffect, VerificationGate } from "../types.js";

export type GateResult = {
  name: string;
  passed: boolean;
  required: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  executionEffect?: DomainExecutionEffect;
  simulatedActionId?: string;
  simulated?: boolean;
};

export type VerificationRunResult = {
  allRequiredPassed: boolean;
  anyOptionalFailed: boolean;
  results: GateResult[];
  totalDurationMs: number;
};

/**
 * Run a set of verification gates sequentially.
 * Stops if total timeout is exceeded.
 */
export function runVerificationGates(
  gates: VerificationGate[],
  workingDir: string,
  options?: {
    totalTimeoutMs?: number;
    defaultGateTimeoutSeconds?: number;
    projectId?: string;
    actor?: string;
    sessionKey?: string;
    taskId?: string;
  },
): VerificationRunResult {
  const startTime = Date.now();
  const totalTimeout = options?.totalTimeoutMs ?? 300_000;
  const defaultGateTimeout = options?.defaultGateTimeoutSeconds ?? 120;
  const results: GateResult[] = [];

  for (const gate of gates) {
    if (Date.now() - startTime > totalTimeout) break;

    const gateStart = Date.now();
    const timeoutMs = (gate.timeout_seconds ?? defaultGateTimeout) * 1000;
    const required = gate.required !== false;
    let stdout = "";
    let stderr = "";
    let exitCode = 1;
    let timedOut = false;
    let executionEffect: DomainExecutionEffect | undefined;
    let simulatedActionId: string | undefined;
    let simulated = false;

    if (options?.projectId) {
      const decision = evaluateCommandExecution(
        {
          projectId: options.projectId,
          actor: options.actor,
          sessionKey: options.sessionKey,
          taskId: options.taskId,
          sourceType: "verification_gate",
          sourceId: gate.name,
          summary: `Would run verification gate ${gate.name}`,
        },
        gate.command,
        { gateName: gate.name, workingDir },
      );
      if (decision.effect !== "allow") {
        executionEffect = decision.effect;
        simulatedActionId = decision.simulatedAction.id;
        simulated = true;
        stderr = decision.reason;
        exitCode = decision.effect === "block" ? 1 : 0;
        results.push({
          name: gate.name,
          passed: false,
          required,
          exitCode,
          stdout: "",
          stderr,
          durationMs: Date.now() - gateStart,
          timedOut: false,
          executionEffect,
          simulatedActionId,
          simulated,
        });
        continue;
      }
    }

    try {
      const result = execSync(gate.command, {
        cwd: workingDir,
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      stdout = typeof result === "string" ? result : "";
      exitCode = 0;
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      exitCode = (e.status as number) ?? 1;
      stdout = (e.stdout as string) ?? "";
      stderr = (e.stderr as string) ?? "";
      timedOut = e.killed === true || e.signal === "SIGTERM";
    }

    const durationMs = Date.now() - gateStart;
    const timeoutSeconds = (gate.timeout_seconds ?? defaultGateTimeout);
    results.push({
      name: gate.name,
      passed: exitCode === 0 && !timedOut,
      required,
      exitCode,
      stdout: stdout.slice(-2000),
      stderr: timedOut
        ? `Gate timed out after ${timeoutSeconds}s`
        : stderr.slice(-2000),
      durationMs,
      timedOut,
      executionEffect,
      simulatedActionId,
      simulated,
    });
  }

  return {
    allRequiredPassed: results.filter((r) => r.required).every((r) => r.passed && !r.timedOut),
    anyOptionalFailed: results.filter((r) => !r.required).some((r) => !r.passed || r.timedOut),
    results,
    totalDurationMs: Date.now() - startTime,
  };
}

/**
 * Build a concise transition failure reason from verification results.
 * Highlights timed-out gates separately from normal failures.
 */
export function getTransitionFailureReason(result: VerificationRunResult): string {
  const timedOut = result.results.filter((r) => r.required && r.timedOut);
  const failed = result.results.filter((r) => r.required && !r.passed && !r.timedOut);

  const parts: string[] = [];
  if (timedOut.length > 0) {
    parts.push(`Timed out: ${timedOut.map((r) => r.name).join(", ")}`);
  }
  if (failed.length > 0) {
    parts.push(`Failed: ${failed.map((r) => r.name).join(", ")}`);
  }
  if (parts.length === 0) return "Required verification gates did not pass";
  return `Required verification gates blocked transition — ${parts.join("; ")}`;
}

/**
 * Format gate results as a readable markdown report.
 */
export function formatGateResults(result: VerificationRunResult): string {
  const lines = ["## Verification Gates\n"];
  for (const r of result.results) {
    const status = r.simulated
      ? (r.executionEffect === "block" ? "BLOCKED" : "SIMULATED")
      : r.timedOut
        ? "TIMEOUT"
        : r.passed ? "PASS" : "FAIL";
    const req = r.required ? "required" : "optional";
    const time = (r.durationMs / 1000).toFixed(1);
    lines.push(`### ${r.name} (${status}) [${req}] - ${time}s`);
    if ((!r.passed || r.simulated) && r.stderr) {
      lines.push("```\n" + r.stderr.slice(-1000) + "\n```");
    }
    if ((!r.passed || r.simulated) && r.stdout && !r.stderr) {
      lines.push("```\n" + r.stdout.slice(-1000) + "\n```");
    }
  }
  const passed = result.results.filter((r) => r.passed).length;
  const total = result.results.length;
  const reqPassed = result.results.filter((r) => r.required && r.passed).length;
  const reqTotal = result.results.filter((r) => r.required).length;
  lines.push(`\n**Summary: ${reqPassed}/${reqTotal} required gates passed. ${passed}/${total} total.**`);
  return lines.join("\n");
}
