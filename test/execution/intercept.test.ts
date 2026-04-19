import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const dbModule = await import("../../src/db.js");
const { getMemoryDb } = dbModule;
const { registerWorkforceConfig, resetEnforcementConfigForTest } = await import("../../src/project.js");
const { evaluateToolExecution, evaluateCommandExecution } = await import("../../src/execution/intercept.js");
const { getProposal } = await import("../../src/approval/resolve.js");
const { getIntentByProposalForProject } = await import("../../src/approval/intent-store.js");
const { listSimulatedActions } = await import("../../src/execution/simulated-actions.js");

describe("execution intercept", () => {
  let db: DatabaseSync;
  const PROJECT = "execution-intercept-test";

  beforeEach(() => {
    db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    resetEnforcementConfigForTest();
    registerWorkforceConfig(PROJECT, {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          briefing: [],
          expectations: [],
          performancePolicy: { action: "retry" },
        },
      },
      execution: {
        mode: "dry_run",
        defaultMutationPolicy: "simulate",
        policies: {
          tools: {
            clawforce_config: {
              actions: {
                set_section: "simulate",
              },
            },
            dangerous_mcp_tool: {
              default: "require_approval",
            },
          },
          commands: [
            { match: "npm run data:validate*", effect: "allow" },
            { match: "npm run data:generate*", effect: "simulate" },
          ],
        },
      },
    });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    resetEnforcementConfigForTest();
    vi.restoreAllMocks();
  });

  it("simulates configured internal tool mutations and records them", () => {
    const decision = evaluateToolExecution({
      projectId: PROJECT,
      agentId: "lead",
      sessionKey: "agent:lead:test",
      toolName: "clawforce_config",
    }, {
      action: "set_section",
      domain: "rentright-data",
      section: "execution",
    }, db);

    expect(decision.effect).toBe("simulate");
    if (decision.effect !== "allow") {
      expect(decision.simulatedAction.policyDecision).toBe("simulate");
      expect(decision.simulatedAction.sourceType).toBe("tool");
    }

    const actions = listSimulatedActions(PROJECT, undefined, db);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionType).toBe("set_section");
  });

  it("requires approval for explicitly gated external tools in dry run", () => {
    const decision = evaluateToolExecution({
      projectId: PROJECT,
      agentId: "lead",
      sessionKey: "agent:lead:test",
      toolName: "dangerous_mcp_tool",
      taskId: "task-approval",
    }, {
      action: "execute",
    }, db);

    expect(decision.effect).toBe("require_approval");
    if (decision.effect !== "allow") {
      expect(decision.simulatedAction.status).toBe("blocked");
      expect(decision.proposal?.id).toBeDefined();
      expect(decision.simulatedAction.proposalId).toBe(decision.proposal?.id);
    }

    const proposal = getProposal(PROJECT, decision.effect === "allow" ? "" : decision.proposal!.id);
    expect(proposal?.origin).toBe("simulated_action");
    const intent = getIntentByProposalForProject(PROJECT, decision.effect === "allow" ? "" : decision.proposal!.id, db);
    expect(intent?.toolName).toBe("dangerous_mcp_tool");
  });

  it("simulates unmatched shell commands in dry run and allows explicit safe commands", () => {
    const allowed = evaluateCommandExecution({ projectId: PROJECT }, "npm run data:validate -- --json", undefined, db);
    expect(allowed.effect).toBe("allow");

    const simulated = evaluateCommandExecution({ projectId: PROJECT }, "npm run data:generate -- --jurisdiction=la", undefined, db);
    expect(simulated.effect).toBe("simulate");

    const actions = listSimulatedActions(PROJECT, undefined, db);
    expect(actions.some((action) => action.targetId?.includes("data:generate"))).toBe(true);
  });
});
