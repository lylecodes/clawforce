/**
 * Clawforce — Verification gate runner
 *
 * Executes configured verification commands (tests, typecheck, lint)
 * and returns structured results for use in lifecycle transitions.
 */

import { execSync } from "node:child_process";
import type { VerificationGate } from "../types.js";

export type GateResult = {
  name: string;
  passed: boolean;
  required: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
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
  options?: { totalTimeoutMs?: number },
): VerificationRunResult {
  const startTime = Date.now();
  const totalTimeout = options?.totalTimeoutMs ?? 300_000;
  const results: GateResult[] = [];

  for (const gate of gates) {
    if (Date.now() - startTime > totalTimeout) break;

    const gateStart = Date.now();
    const timeoutMs = (gate.timeout_seconds ?? 120) * 1000;
    const required = gate.required !== false;
    let stdout = "";
    let stderr = "";
    let exitCode = 1;
    let timedOut = false;

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

    results.push({
      name: gate.name,
      passed: exitCode === 0,
      required,
      exitCode,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
      durationMs: Date.now() - gateStart,
      timedOut,
    });
  }

  return {
    allRequiredPassed: results.filter((r) => r.required).every((r) => r.passed),
    anyOptionalFailed: results.filter((r) => !r.required).some((r) => !r.passed),
    results,
    totalDurationMs: Date.now() - startTime,
  };
}

/**
 * Format gate results as a readable markdown report.
 */
export function formatGateResults(result: VerificationRunResult): string {
  const lines = ["## Verification Gates\n"];
  for (const r of result.results) {
    const status = r.passed ? "PASS" : "FAIL";
    const req = r.required ? "required" : "optional";
    const time = (r.durationMs / 1000).toFixed(1);
    lines.push(`### ${r.name} (${status}) [${req}] - ${time}s`);
    if (!r.passed && r.stderr) {
      lines.push("```\n" + r.stderr.slice(-1000) + "\n```");
    }
    if (!r.passed && r.stdout && !r.stderr) {
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
