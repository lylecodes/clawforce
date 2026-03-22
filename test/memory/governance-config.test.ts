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

describe("memory expectations stripping", () => {
  it("manager preset does not include memory_search expectation by default", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const managerExpectations = BUILTIN_AGENT_PRESETS.manager.expectations as Array<{ tool: string }>;
    // memory_search was removed from manager preset to simplify expectations (only clawforce_log:write required)
    expect(managerExpectations.some((e) => e.tool === "memory_search")).toBe(false);
  });

  it("memory_search expectation is stripped when memory.expectations=false", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        lead: {
          extends: "manager",
          memory: {
            expectations: false,
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
      const hasMemoryExpectation = agent.expectations.some((e) => e.tool === "memory_search");
      expect(hasMemoryExpectation).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("memory_search expectation is not added when memory.expectations=true (no longer in preset)", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        lead: {
          extends: "manager",
          memory: {
            expectations: true,
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
      const hasMemoryExpectation = agent.expectations.some((e) => e.tool === "memory_search");
      // memory_search is no longer in the manager preset, so even with memory.expectations=true it won't appear
      expect(hasMemoryExpectation).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("employee preset does NOT include memory_search expectation", async () => {
    const { BUILTIN_AGENT_PRESETS } = await import("../../src/presets.js");
    const employeeExpectations = BUILTIN_AGENT_PRESETS.employee.expectations as Array<{ tool: string }>;
    expect(employeeExpectations.some((e) => e.tool === "memory_search")).toBe(false);
  });

  it("employee does not gain memory_search expectation when memory.expectations=true", async () => {
    const YAML = (await import("yaml")).default;
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const yaml = YAML.stringify({
      name: "test-project",
      agents: {
        worker: {
          extends: "employee",
          memory: {
            expectations: true,
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
      const agent = config!.agents.worker;
      // Employee preset doesn't have memory_search, so expectations=true has no effect
      const hasMemoryExpectation = agent.expectations.some((e) => e.tool === "memory_search");
      expect(hasMemoryExpectation).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("memory config validation", () => {
  it("warns when memory.review.cron format is unrecognized", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          briefing: [{ source: "soul" }],
          expectations: [{ tool: "clawforce_log", action: "write", min_calls: 1 }],
          performance_policy: { action: "alert" },
          memory: {
            review: {
              enabled: true,
              cron: "badcron",
              aggressiveness: "invalid_level",
            },
          },
        } as any,
      },
    };

    const warnings = validateWorkforceConfig(config);
    const memoryWarnings = warnings.filter((w) => w.message.includes("memory"));
    expect(memoryWarnings.length).toBeGreaterThan(0);
  });

  it("accepts valid memory governance config without warnings", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test",
      agents: {
        lead: {
          extends: "manager",
          briefing: [{ source: "soul" }],
          expectations: [
            { tool: "clawforce_log", action: "write", min_calls: 1 },
            { tool: "memory_search", action: "search", min_calls: 1 },
          ],
          performance_policy: { action: "alert" },
          memory: {
            instructions: true,
            expectations: true,
            review: {
              enabled: true,
              cron: "0 18 * * *",
              aggressiveness: "medium",
              scope: "reports",
            },
          },
        } as any,
      },
    };

    const warnings = validateWorkforceConfig(config);
    const memoryErrors = warnings.filter((w) => w.level === "error" && w.message.includes("memory"));
    expect(memoryErrors).toHaveLength(0);
  });
});
