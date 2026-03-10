import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { emitDiagnosticEvent } = await import("../../src/diagnostics.js");
const { resolveEscalationTarget, routeEscalation } = await import("../../src/enforcement/escalation-router.js");
import type { AgentConfig } from "../../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "employee",
    context_in: [{ source: "instructions" }],
    required_outputs: [],
    on_failure: { action: "alert" },
    ...overrides,
  };
}

describe("resolveEscalationTarget", () => {
  it("returns parent when reports_to is absent", () => {
    const target = resolveEscalationTarget(makeConfig());
    expect(target).toEqual({ kind: "parent" });
  });

  it("returns parent when reports_to is 'parent'", () => {
    const target = resolveEscalationTarget(makeConfig({ reports_to: "parent" }));
    expect(target).toEqual({ kind: "parent" });
  });

  it("returns named_agent for a specific agent name", () => {
    const target = resolveEscalationTarget(makeConfig({ reports_to: "leon" }));
    expect(target).toEqual({ kind: "named_agent", agentId: "leon" });
  });
});

describe("routeEscalation", () => {
  const logger = { warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits diagnostic event for parent target (auto-announce handles delivery)", async () => {
    const injectAgentMessage = vi.fn();
    await routeEscalation({
      injectAgentMessage,
      target: { kind: "parent" },
      message: "Agent failed",
      sourceAgentId: "coder",
      logger,
    });

    expect(injectAgentMessage).not.toHaveBeenCalled();
    expect(emitDiagnosticEvent).toHaveBeenCalledWith({
      type: "escalation_to_parent",
      sourceAgentId: "coder",
      message: "Agent failed",
    });
  });

  it("injects message for named_agent target", async () => {
    const injectAgentMessage = vi.fn().mockResolvedValue({ runId: "run-1" });
    await routeEscalation({
      injectAgentMessage,
      target: { kind: "named_agent", agentId: "leon" },
      message: "Coder failed compliance",
      sourceAgentId: "coder",
      logger,
    });

    expect(injectAgentMessage).toHaveBeenCalledWith({
      sessionKey: "agent:leon",
      message: "Coder failed compliance",
    });
  });

  it("emits diagnostic event on successful named_agent escalation", async () => {
    const injectAgentMessage = vi.fn().mockResolvedValue({ runId: "run-1" });
    await routeEscalation({
      injectAgentMessage,
      target: { kind: "named_agent", agentId: "leon" },
      message: "Coder failed compliance",
      sourceAgentId: "coder",
      logger,
    });

    expect(emitDiagnosticEvent).toHaveBeenCalledWith({
      type: "escalation_delivered",
      targetAgentId: "leon",
      sourceAgentId: "coder",
    });
  });

  it("emits diagnostic event on failed named_agent escalation", async () => {
    const injectAgentMessage = vi.fn().mockRejectedValue(new Error("gateway down"));
    await routeEscalation({
      injectAgentMessage,
      target: { kind: "named_agent", agentId: "leon" },
      message: "Coder failed",
      sourceAgentId: "coder",
      logger,
    });

    expect(emitDiagnosticEvent).toHaveBeenCalledWith({
      type: "escalation_failed",
      targetAgentId: "leon",
      sourceAgentId: "coder",
      reason: "gateway down",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway down"),
    );
  });
});
