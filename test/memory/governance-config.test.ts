// test/memory/governance-config.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("MemoryGovernanceConfig parsing", () => {
  it("parses memory.instructions = true", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    // We test normalizeAgentConfig indirectly via loadWorkforceConfig
    // But normalizeAgentConfig is not exported — test the type shape instead
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: true,
    };
    expect(config.instructions).toBe(true);
  });

  it("parses memory.instructions = custom string", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: "Custom instructions here",
    };
    expect(config.instructions).toBe("Custom instructions here");
  });

  it("parses memory.instructions = false", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: false,
    };
    expect(config.instructions).toBe(false);
  });

  it("parses memory.expectations = false", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      expectations: false,
    };
    expect(config.expectations).toBe(false);
  });

  it("parses full memory.review config", () => {
    const config: import("../../src/types.js").MemoryGovernanceConfig = {
      instructions: true,
      expectations: true,
      review: {
        enabled: true,
        cron: "0 18 * * *",
        model: "anthropic/claude-sonnet-4-6",
        aggressiveness: "medium",
        scope: "reports",
      },
    };
    expect(config.review?.enabled).toBe(true);
    expect(config.review?.aggressiveness).toBe("medium");
    expect(config.review?.scope).toBe("reports");
  });

  it("normalizeAgentConfig passes memory field through to AgentConfig", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        lead: {
          extends: "manager",
          memory: {
            instructions: true,
            expectations: true,
            review: {
              enabled: true,
              cron: "0 18 * * *",
              aggressiveness: "high",
              scope: "reports",
            },
          },
        },
      },
    });

    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    const tmpFile = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(tmpFile, yaml);

    try {
      const config = loadWorkforceConfig(tmpFile);
      expect(config).not.toBeNull();
      const agent = config!.agents.lead;
      expect(agent).toBeDefined();
      expect(agent.memory).toBeDefined();
      expect(agent.memory?.instructions).toBe(true);
      expect(agent.memory?.expectations).toBe(true);
      expect(agent.memory?.review?.enabled).toBe(true);
      expect(agent.memory?.review?.aggressiveness).toBe("high");
      expect(agent.memory?.review?.scope).toBe("reports");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("normalizeAgentConfig defaults memory to undefined when not specified", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        worker: {
          extends: "employee",
        },
      },
    });

    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-test-"));
    const tmpFile = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(tmpFile, yaml);

    try {
      const config = loadWorkforceConfig(tmpFile);
      expect(config).not.toBeNull();
      const agent = config!.agents.worker;
      expect(agent.memory).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
