import { describe, expect, it } from "vitest";
import { runVerificationGates, formatGateResults } from "../../src/verification/runner.js";
import type { VerificationGate } from "../../src/types.js";

describe("verification/runner", () => {
  it("runs a passing gate", () => {
    const gates: VerificationGate[] = [
      { name: "echo-test", command: "echo hello", required: true },
    ];

    const result = runVerificationGates(gates, process.cwd());

    expect(result.allRequiredPassed).toBe(true);
    expect(result.anyOptionalFailed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.passed).toBe(true);
    expect(result.results[0]!.exitCode).toBe(0);
    expect(result.results[0]!.stdout).toContain("hello");
    expect(result.results[0]!.required).toBe(true);
    expect(result.totalDurationMs).toBeGreaterThan(0);
  });

  it("runs a failing gate", () => {
    const gates: VerificationGate[] = [
      { name: "fail-test", command: "exit 1", required: true },
    ];

    const result = runVerificationGates(gates, process.cwd());

    expect(result.allRequiredPassed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.passed).toBe(false);
    expect(result.results[0]!.exitCode).toBe(1);
  });

  it("handles optional gates", () => {
    const gates: VerificationGate[] = [
      { name: "required-pass", command: "echo ok", required: true },
      { name: "optional-fail", command: "exit 1", required: false },
    ];

    const result = runVerificationGates(gates, process.cwd());

    expect(result.allRequiredPassed).toBe(true);
    expect(result.anyOptionalFailed).toBe(true);
    expect(result.results).toHaveLength(2);
  });

  it("runs multiple gates sequentially", () => {
    const gates: VerificationGate[] = [
      { name: "first", command: "echo first", required: true },
      { name: "second", command: "echo second", required: true },
      { name: "third", command: "echo third", required: false },
    ];

    const result = runVerificationGates(gates, process.cwd());

    expect(result.allRequiredPassed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.name)).toEqual(["first", "second", "third"]);
  });

  it("defaults required to true when not specified", () => {
    const gates: VerificationGate[] = [
      { name: "no-required-field", command: "echo ok" },
    ];

    const result = runVerificationGates(gates, process.cwd());

    expect(result.results[0]!.required).toBe(true);
  });

  it("handles per-gate timeout", () => {
    const gates: VerificationGate[] = [
      { name: "slow-gate", command: "sleep 10", timeout_seconds: 1, required: true },
    ];

    const result = runVerificationGates(gates, process.cwd());

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.passed).toBe(false);
    expect(result.results[0]!.timedOut).toBe(true);
  }, 10_000);

  it("captures stderr on failure", () => {
    const gates: VerificationGate[] = [
      { name: "stderr-test", command: "echo error-output >&2 && exit 1", required: true },
    ];

    const result = runVerificationGates(gates, process.cwd());

    expect(result.results[0]!.passed).toBe(false);
    expect(result.results[0]!.stderr).toContain("error-output");
  });

  describe("formatGateResults", () => {
    it("formats passing results", () => {
      const result = runVerificationGates(
        [{ name: "test-gate", command: "echo ok", required: true }],
        process.cwd(),
      );

      const formatted = formatGateResults(result);

      expect(formatted).toContain("## Verification Gates");
      expect(formatted).toContain("test-gate (PASS)");
      expect(formatted).toContain("[required]");
      expect(formatted).toContain("1/1 required gates passed");
    });

    it("formats failing results with stderr", () => {
      const result = runVerificationGates(
        [{ name: "fail-gate", command: "echo bad >&2 && exit 1", required: true }],
        process.cwd(),
      );

      const formatted = formatGateResults(result);

      expect(formatted).toContain("fail-gate (FAIL)");
      expect(formatted).toContain("0/1 required gates passed");
      expect(formatted).toContain("bad");
    });
  });
});
