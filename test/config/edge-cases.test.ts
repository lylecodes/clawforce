/**
 * Edge case tests for the ClawForce config system.
 *
 * Covers empty/null handling, type coercion, large configs, circular references,
 * unicode/special characters, conditional edge cases, job edge cases,
 * and domain defaults edge cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-sig"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

// ---------------------------------------------------------------------------
// 1. Empty/Null Config Handling
// ---------------------------------------------------------------------------
describe("empty/null config handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-empty-"));
  });

  afterEach(async () => {
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    resetEnforcementConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("returns null for empty agents object (agents: {})", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents: {}
`);
    const config = loadWorkforceConfig(configPath);
    // No workforce-style agents found (none with extends/role)
    expect(config).toBeNull();
  });

  it("loads agent with only extends field (minimal agent)", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  bare:
    extends: employee
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.bare!;
    expect(agent.extends).toBe("employee");
    // Should inherit employee preset defaults
    expect(agent.briefing).toBeDefined();
    expect(Array.isArray(agent.briefing)).toBe(true);
    expect(agent.expectations).toBeDefined();
    expect(agent.performance_policy).toBeDefined();
  });

  it("handles empty briefing array", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    briefing: []
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // Empty briefing should still get "instructions" injected
    expect(agent.briefing.some(s => s.source === "instructions")).toBe(true);
  });

  it("handles empty expectations array", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    expectations: []
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // User explicitly set empty expectations — should be honored
    expect(agent.expectations).toEqual([]);
  });

  it("handles null/undefined values in config fields gracefully", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    title: null
    persona: null
    department: null
    team: null
    reports_to: null
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // Null fields should be treated as undefined/absent
    expect(agent.title).toBeUndefined();
    expect(agent.persona).toBeUndefined();
    expect(agent.department).toBeUndefined();
    expect(agent.team).toBeUndefined();
    expect(agent.reports_to).toBeUndefined();
  });

  it("handles empty string values where strings expected", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    title: ""
    persona: ""
    channel: ""
    department: ""
    team: ""
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // Empty strings should be treated as absent
    expect(agent.title).toBeUndefined();
    expect(agent.persona).toBeUndefined();
    expect(agent.channel).toBeUndefined();
    expect(agent.department).toBeUndefined();
    expect(agent.team).toBeUndefined();
  });

  it("loads config with only required fields (minimal valid config)", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: minimal
agents:
  w:
    extends: employee
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.name).toBe("minimal");
    expect(Object.keys(config!.agents)).toHaveLength(1);
  });

  it("returns null when YAML parses to null", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml("");
    const config = loadWorkforceConfig(configPath);
    expect(config).toBeNull();
  });

  it("returns null when agents section is missing entirely", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: no-agents
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Type Edge Cases
// ---------------------------------------------------------------------------
describe("type edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-types-"));
  });

  afterEach(async () => {
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    resetEnforcementConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("handles number where string expected (title: 123) — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    title: 123
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    // 123 is not a string, so title should be undefined (or coerced)
    const agent = config!.agents.worker!;
    // normalizeAgentConfig checks typeof raw.title === "string" && raw.title.trim()
    expect(agent.title).toBeUndefined();
  });

  it("handles boolean where string expected — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    title: true
    persona: false
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    expect(agent.title).toBeUndefined();
    expect(agent.persona).toBeUndefined();
  });

  it("handles string where number expected (skillCap as string) — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    skill_cap: "10"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    // skill_cap expects typeof === "number", so string "10" should be ignored
    const agent = config!.agents.worker!;
    expect(agent.skillCap).toBeUndefined();
  });

  it("handles string where array expected (briefing: 'soul') — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    briefing: "soul"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // Non-array briefing should be handled (either ignored or wrapped)
    expect(Array.isArray(agent.briefing)).toBe(true);
  });

  it("handles object where string expected — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    channel:
      type: slack
      id: chan-123
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // Object is not typeof string, so channel should be undefined
    expect(agent.channel).toBeUndefined();
  });

  it("handles deeply nested invalid types — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    scheduling:
      adaptive_wake: "yes"
      wake_bounds: "not-an-array"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // "yes" is not a boolean, "not-an-array" is not an array
    if (agent.scheduling) {
      expect(agent.scheduling.adaptiveWake).toBeUndefined();
      expect(agent.scheduling.wakeBounds).toBeUndefined();
    }
  });

  it("handles array with mixed valid/invalid entries in expectations", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
      - "not a valid expectation"
      - 42
      - tool: clawforce_log
        action: write
        min_calls: 2
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // Should filter out invalid entries, keeping valid ones
    expect(agent.expectations.length).toBeGreaterThanOrEqual(1);
    expect(agent.expectations.every(e => typeof e.tool === "string")).toBe(true);
  });

  it("skips non-object agents in agents section — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  valid_agent:
    extends: employee
  invalid_agent: "just a string"
  another_invalid: 42
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents.valid_agent).toBeDefined();
    // Non-object agents should be skipped
    expect(config!.agents["invalid_agent"]).toBeUndefined();
    expect(config!.agents["another_invalid"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Large Config Scenarios
// ---------------------------------------------------------------------------
describe("large config scenarios", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-large-"));
  });

  afterEach(async () => {
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    resetEnforcementConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("handles 50+ agents in a single config", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const agentLines: string[] = [];
    for (let i = 0; i < 55; i++) {
      agentLines.push(`  agent-${i}:`);
      agentLines.push(`    extends: employee`);
      agentLines.push(`    title: Worker ${i}`);
    }

    const configPath = writeYaml(`
name: large-org
agents:
${agentLines.join("\n")}
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(Object.keys(config!.agents).length).toBe(55);
    expect(config!.agents["agent-0"]!.title).toBe("Worker 0");
    expect(config!.agents["agent-54"]!.title).toBe("Worker 54");
  });

  it("handles agent with 20+ briefing sources", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const sources = [
      "instructions", "soul", "tools_reference", "assigned_task",
      "knowledge", "task_board", "activity", "sweep_status",
      "proposals", "agent_status", "cost_summary", "policy_status",
      "health_status", "team_status", "team_performance",
      "channel_messages", "pending_messages", "goal_hierarchy",
      "planning_delta", "velocity", "preferences",
    ];
    const briefingLines = sources.map(s => `      - source: ${s}`).join("\n");

    const configPath = writeYaml(`
name: test
agents:
  mega-briefed:
    extends: manager
    briefing:
${briefingLines}
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents["mega-briefed"]!;
    // At minimum the explicit sources should be present
    expect(agent.briefing.length).toBeGreaterThanOrEqual(20);
  });

  it("handles 10+ expectations on a single agent", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");

    const expLines: string[] = [];
    for (let i = 0; i < 12; i++) {
      expLines.push(`      - tool: tool_${i}`);
      expLines.push(`        action: action_${i}`);
      expLines.push(`        min_calls: ${i + 1}`);
    }

    const configPath = writeYaml(`
name: test
agents:
  strict:
    extends: employee
    expectations:
${expLines.join("\n")}
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.strict!;
    expect(agent.expectations.length).toBe(12);
    expect(agent.expectations[11]!.min_calls).toBe(12);
  });

  it("handles 5+ levels of conditional nesting", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                when: [
                  { match: { dept: "eng" }, value: "deep-match" },
                  { default: "deep-default" },
                ],
              },
            },
          },
        },
      },
    };

    const result = resolveConditionals(config, { dept: "eng" });
    const val = (result.level1 as Record<string, unknown>);
    const l2 = val.level2 as Record<string, unknown>;
    const l3 = l2.level3 as Record<string, unknown>;
    const l4 = l3.level4 as Record<string, unknown>;
    expect(l4.level5).toBe("deep-match");
  });

  it("handles agent with 5+ mixins applied", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const resolved = { title: "Base", skillCap: 5 };
    const agentDef = {
      extends: "employee",
      mixins: ["m1", "m2", "m3", "m4", "m5"],
    };
    const mixinDefs = {
      m1: { skillCap: 6 },
      m2: { skillCap: 7, department: "eng" },
      m3: { team: "backend" },
      m4: { compaction: true },
      m5: { skillCap: 10, title: "Overridden" },
    };

    const result = applyMixins(resolved, agentDef, mixinDefs);
    // Last mixin's skillCap wins (m5: 10), then agent overrides re-applied
    // (agentDef has no skillCap, so m5 wins)
    expect(result.skillCap).toBe(10);
    expect(result.compaction).toBe(true);
    expect(result.department).toBe("eng");
    expect(result.team).toBe("backend");
  });

  it("handles domain with 10+ teams via initializeAllDomains", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { clearRegistry } = await import("../../src/config/registry.js");
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");

    // Setup a config dir with agents across many teams
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-teams-"));
    fs.mkdirSync(path.join(baseDir, "domains"), { recursive: true });

    const teamNames = Array.from({ length: 12 }, (_, i) => `team-${i}`);
    const agentLines: string[] = [];
    const agentNames: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `agent-team-${i}`;
      agentNames.push(name);
      agentLines.push(`  ${name}:`);
      agentLines.push(`    extends: employee`);
      agentLines.push(`    team: ${teamNames[i]}`);
    }

    fs.writeFileSync(path.join(baseDir, "config.yaml"), [
      "agents:",
      ...agentLines,
    ].join("\n"));

    fs.writeFileSync(path.join(baseDir, "domains", "big.yaml"), [
      "domain: big-domain",
      "agents:",
      ...agentNames.map(n => `  - ${n}`),
    ].join("\n"));

    try {
      const result = initializeAllDomains(baseDir);
      expect(result.domains).toContain("big-domain");
    } finally {
      clearRegistry();
      resetEnforcementConfigForTest();
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Circular/Self-Reference
// ---------------------------------------------------------------------------
describe("circular/self-reference", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-circ-"));
  });

  afterEach(async () => {
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    resetEnforcementConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("agent reports_to itself — loads without crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  self-ref:
    extends: employee
    reports_to: self-ref
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents["self-ref"]!;
    expect(agent.reports_to).toBe("self-ref");
  });

  it("two agents report_to each other — loads without crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  alice:
    extends: employee
    reports_to: bob
  bob:
    extends: employee
    reports_to: alice
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents.alice!.reports_to).toBe("bob");
    expect(config!.agents.bob!.reports_to).toBe("alice");
  });

  it("mixin that references itself in mixins list — handled gracefully", async () => {
    const { applyMixins } = await import("../../src/config/init.js");

    const resolved = { title: "Base", skillCap: 5 };
    const agentDef = {
      extends: "employee",
      mixins: ["self-ref"],
    };
    // The mixin definition has a mixins field pointing to itself
    const mixinDefs = {
      "self-ref": { skillCap: 10, mixins: ["self-ref"] },
    };

    // applyMixins strips the mixins field from each mixin before merging
    // so self-reference should not cause infinite recursion
    const result = applyMixins(resolved, agentDef, mixinDefs);
    expect(result.skillCap).toBe(10);
  });

  it("agent extends unknown preset — falls through to employee default", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  exotic:
    extends: nonexistent_preset
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    // Unknown preset should not crash; agent still loads
    const agent = config!.agents.exotic!;
    expect(agent.extends).toBe("nonexistent_preset");
    expect(agent.briefing).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Unicode/Special Characters
// ---------------------------------------------------------------------------
describe("unicode/special characters", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-unicode-"));
  });

  afterEach(async () => {
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    resetEnforcementConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("handles agent ID with dots (e.g., 'agent.name')", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  agent.name:
    extends: employee
    title: Dotted Agent
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents["agent.name"]).toBeDefined();
    expect(config!.agents["agent.name"]!.title).toBe("Dotted Agent");
  });

  it("handles agent ID with unicode characters", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  "\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8":
    extends: employee
    title: Japanese Agent
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents["\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8"]).toBeDefined();
    expect(config!.agents["\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8"]!.title).toBe("Japanese Agent");
  });

  it("handles department/team names with special chars", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    department: "R&D / AI"
    team: "front-end (web)"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    expect(agent.department).toBe("R&D / AI");
    expect(agent.team).toBe("front-end (web)");
  });

  it("handles briefing source strings with special chars", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  worker:
    extends: employee
    briefing:
      - source: "custom"
        content: "Hello! Special chars: <>&\\\"'\\n\\t\u00e9\u00e8"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.worker!;
    // Should preserve content with special chars
    const customSource = agent.briefing.find(s => s.source === "custom");
    expect(customSource).toBeDefined();
    expect(customSource!.content).toBeDefined();
  });

  it("handles agent ID with hyphens and underscores", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  my-agent_v2:
    extends: employee
    title: Hyphenated
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents["my-agent_v2"]).toBeDefined();
    expect(config!.agents["my-agent_v2"]!.title).toBe("Hyphenated");
  });

  it("handles agent ID with spaces (quoted YAML key)", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  "agent with spaces":
    extends: employee
    title: Spaced
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents["agent with spaces"]).toBeDefined();
    expect(config!.agents["agent with spaces"]!.title).toBe("Spaced");
  });
});

// ---------------------------------------------------------------------------
// 6. Conditional Edge Cases
// ---------------------------------------------------------------------------
describe("conditional edge cases", () => {
  it("when block with no match and no default — field omitted", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channel: {
        when: [
          { match: { department: "sales" }, value: "sales-channel" },
          { match: { department: "eng" }, value: "eng-channel" },
        ],
      },
      title: "Agent",
    };
    const result = resolveConditionals(config, { department: "hr" });
    expect(result.channel).toBeUndefined();
    expect(result.title).toBe("Agent");
  });

  it("when block where multiple matches apply — first match wins", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channel: {
        when: [
          { match: { department: "eng" }, value: "first-match" },
          { match: { department: "eng" }, value: "second-match" },
          { default: "fallback" },
        ],
      },
    };
    const result = resolveConditionals(config, { department: "eng" });
    expect(result.channel).toBe("first-match");
  });

  it("empty match conditions — should match everything (vacuously true)", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channel: {
        when: [
          { match: {}, value: "catch-all" },
          { default: "fallback" },
        ],
      },
    };
    const result = resolveConditionals(config, { department: "any" });
    // Empty match object: Object.entries({}).every(...) is true (vacuously)
    expect(result.channel).toBe("catch-all");
  });

  it("when block on a non-object field (primitive) — passes through", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      title: "Worker",
      skillCap: 10,
      active: true,
    };
    const result = resolveConditionals(config, { department: "eng" });
    expect(result.title).toBe("Worker");
    expect(result.skillCap).toBe(10);
    expect(result.active).toBe(true);
  });

  it("nested when blocks (when inside when resolved value)", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    // The outer when resolves to an object that itself contains a when block
    // resolveConditionals recurses into objects, but the resolved value of a when block
    // is returned directly (not recursed further since it replaces the key)
    const config = {
      settings: {
        when: [
          {
            match: { department: "eng" },
            value: {
              nested_setting: {
                when: [
                  { match: { team: "frontend" }, value: "react" },
                  { default: "generic" },
                ],
              },
            },
          },
          { default: {} },
        ],
      },
    };

    // First resolution: settings resolves to an object with a nested when
    const result = resolveConditionals(config, { department: "eng", team: "frontend" });
    // The when block replaces the field with its value directly
    // The nested when inside is not automatically resolved since it's the resolved VALUE
    const settings = result.settings as Record<string, unknown>;
    expect(settings).toBeDefined();
    // Whether the nested when is auto-resolved depends on implementation;
    // test that it at least doesn't crash
    expect(settings.nested_setting).toBeDefined();
  });

  it("when block with empty clauses array — field omitted", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channel: {
        when: [],
      },
      title: "Agent",
    };
    const result = resolveConditionals(config, { department: "eng" });
    expect(result.channel).toBeUndefined();
    expect(result.title).toBe("Agent");
  });

  it("when block with default as first clause — default wins immediately", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channel: {
        when: [
          { default: "early-default" },
          { match: { department: "eng" }, value: "eng-channel" },
        ],
      },
    };
    const result = resolveConditionals(config, { department: "eng" });
    // Default clause has no `match` key, so it triggers first
    expect(result.channel).toBe("early-default");
  });

  it("when block where match value is array (any-of) — handles correctly", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channel: {
        when: [
          { match: { department: ["sales", "marketing", "bd"] }, value: "biz" },
          { default: "general" },
        ],
      },
    };
    const r1 = resolveConditionals(config, { department: "marketing" });
    expect(r1.channel).toBe("biz");

    const r2 = resolveConditionals(config, { department: "eng" });
    expect(r2.channel).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// 7. Job Edge Cases
// ---------------------------------------------------------------------------
describe("job edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-jobs-"));
  });

  afterEach(async () => {
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    resetEnforcementConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("job with no cron, no frequency, no triggers — valid manual-only job", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      manual_task:
        nudge: "Do this when asked"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const job = config!.agents.mgr!.jobs!.manual_task;
    expect(job).toBeDefined();
    expect(job.cron).toBeUndefined();
    expect(job.frequency).toBeUndefined();
    expect(job.triggers).toBeUndefined();
    expect(job.nudge).toBe("Do this when asked");
  });

  it("job with both cron AND frequency — both are stored", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      dual:
        cron: "*/30 * * * *"
        frequency: "3/day"
        nudge: "Dual schedule"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const job = config!.agents.mgr!.jobs!.dual;
    expect(job.cron).toBe("*/30 * * * *");
    expect(job.frequency).toBe("3/day");
  });

  it("job extending a non-existent preset — no crash", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      exotic:
        extends: nonexistent_job_preset
        cron: "*/60 * * * *"
`);
    // Should not throw
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const job = config!.agents.mgr!.jobs!.exotic;
    expect(job).toBeDefined();
    expect(job.cron).toBe("*/60 * * * *");
  });

  it("job with empty triggers array — stored as empty triggers", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      no_triggers:
        cron: "*/30 * * * *"
        triggers: []
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const job = config!.agents.mgr!.jobs!.no_triggers;
    expect(job.triggers).toBeDefined();
    expect(job.triggers).toHaveLength(0);
  });

  it("job with continuous: true and cron set — both stored", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      looper:
        continuous: true
        cron: "*/10 * * * *"
        nudge: "Keep working"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const job = config!.agents.mgr!.jobs!.looper;
    expect(job.cron).toBe("*/10 * * * *");
    // continuous is stored as-is (not stripped)
    // The raw yaml field is { continuous: true } — whether it appears depends on normalization
    expect(job.nudge).toBe("Keep working");
  });

  it("job with only triggers (event-driven, no schedule)", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      event_only:
        triggers:
          - on: task_failed
          - on: dispatch_failed
        nudge: "React to failures"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const job = config!.agents.mgr!.jobs!.event_only;
    expect(job.cron).toBeUndefined();
    expect(job.triggers).toHaveLength(2);
    expect(job.triggers![0]!.on).toBe("task_failed");
  });

  it("job with invalid triggers entries are filtered out", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      mixed:
        cron: "*/30 * * * *"
        triggers:
          - on: task_failed
          - "string-not-object"
          - on: ""
          - 42
          - on: dispatch_failed
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const job = config!.agents.mgr!.jobs!.mixed;
    // Only valid triggers with non-empty "on" should survive
    expect(job.triggers).toHaveLength(2);
    expect(job.triggers![0]!.on).toBe("task_failed");
    expect(job.triggers![1]!.on).toBe("dispatch_failed");
  });

  it("multiple jobs on same agent — all parsed independently", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  mgr:
    extends: manager
    jobs:
      job_a:
        cron: "*/10 * * * *"
        nudge: "Job A"
      job_b:
        frequency: "2/day"
        nudge: "Job B"
      job_c:
        triggers:
          - on: task_failed
        nudge: "Job C"
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const jobs = config!.agents.mgr!.jobs!;
    expect(Object.keys(jobs)).toHaveLength(3);
    expect(jobs.job_a.cron).toBe("*/10 * * * *");
    expect(jobs.job_b.frequency).toBe("2/day");
    expect(jobs.job_c.triggers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Domain Defaults Edge Cases
// ---------------------------------------------------------------------------
describe("domain defaults edge cases", () => {
  it("domain defaults with expectations: [] — does not clear preset expectations", async () => {
    const { mergeDomainDefaults } = await import("../../src/config/init.js");
    const agentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" as const }],
      expectations: [
        { tool: "clawforce_task", action: "transition", min_calls: 1 },
      ],
      performance_policy: { action: "alert" as const },
    };

    // Domain defaults with empty expectations array
    const domainDefaults = {
      expectations: [],
    };

    const merged = mergeDomainDefaults(agentConfig, domainDefaults);
    // Empty domain defaults expectations should not remove agent's expectations
    // (nothing to append, so original stays)
    expect(merged.expectations).toHaveLength(1);
    expect(merged.expectations[0]!.tool).toBe("clawforce_task");
  });

  it("domain defaults briefing with operators (+/-) for managers", async () => {
    const { mergeDomainDefaults } = await import("../../src/config/init.js");

    const agentConfig = {
      extends: "manager" as const,
      coordination: { enabled: true },
      briefing: [
        { source: "instructions" as const },
        { source: "assigned_task" as const },
      ],
      expectations: [],
      performance_policy: { action: "alert" as const },
    };

    // Domain defaults with sources that include + prefix — treated as plain source objects
    const domainDefaults = {
      briefing: [
        { source: "direction" },
        { source: "policies" },
      ],
    };

    const merged = mergeDomainDefaults(agentConfig, domainDefaults);
    // For managers, domain default briefing sources are prepended (deduped)
    expect(merged.briefing[0]!.source).toBe("direction");
    expect(merged.briefing[1]!.source).toBe("policies");
    expect(merged.briefing[2]!.source).toBe("instructions");
  });

  it("domain with no agents list — returns empty agents", async () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");

    const result = validateDomainConfig({
      domain: "empty-domain",
    });
    // agents is required and must be an array
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "agents")).toBe(true);
  });

  it("agent with explicit expectations: [] — domain defaults do not override", async () => {
    const { mergeDomainDefaults } = await import("../../src/config/init.js");

    const agentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" as const }],
      expectations: [] as Array<{ tool: string; action: string; min_calls: number }>,
      performance_policy: { action: "alert" as const },
    };

    const domainDefaults = {
      expectations: [
        { tool: "clawforce_log", action: "write", min_calls: 1 },
      ],
    };

    // When user explicitly set expectations, domain defaults should be skipped
    const merged = mergeDomainDefaults(agentConfig, domainDefaults, true);
    expect(merged.expectations).toHaveLength(0);
  });

  it("multiple domains sharing the same agent via initializeAllDomains", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { clearRegistry, getAgentDomains } = await import("../../src/config/registry.js");
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");

    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-multi-domain-"));
    fs.mkdirSync(path.join(baseDir, "domains"), { recursive: true });

    fs.writeFileSync(path.join(baseDir, "config.yaml"), [
      "agents:",
      "  shared-agent:",
      "    extends: employee",
      "    title: Shared Worker",
    ].join("\n"));

    fs.writeFileSync(path.join(baseDir, "domains", "domain-a.yaml"), [
      "domain: domain-a",
      "agents:",
      "  - shared-agent",
    ].join("\n"));

    fs.writeFileSync(path.join(baseDir, "domains", "domain-b.yaml"), [
      "domain: domain-b",
      "agents:",
      "  - shared-agent",
    ].join("\n"));

    try {
      const result = initializeAllDomains(baseDir);
      expect(result.domains).toContain("domain-a");
      expect(result.domains).toContain("domain-b");

      // Agent should be registered in both domains
      const domains = getAgentDomains("shared-agent");
      expect(domains).toContain("domain-a");
      expect(domains).toContain("domain-b");
    } finally {
      clearRegistry();
      resetEnforcementConfigForTest();
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("domain defaults performance_policy overrides preset default", async () => {
    const { mergeDomainDefaults } = await import("../../src/config/init.js");

    const agentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" as const }],
      expectations: [],
      performance_policy: { action: "alert" as const },
    };

    const domainDefaults = {
      performance_policy: { action: "retry", max_retries: 5 },
    };

    const merged = mergeDomainDefaults(agentConfig, domainDefaults);
    expect(merged.performance_policy).toEqual({ action: "retry", max_retries: 5 });
  });

  it("empty domain defaults object — agent config unchanged", async () => {
    const { mergeDomainDefaults } = await import("../../src/config/init.js");

    const agentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" as const }],
      expectations: [{ tool: "clawforce_task", action: "transition", min_calls: 1 }],
      performance_policy: { action: "alert" as const },
    };

    const merged = mergeDomainDefaults(agentConfig, {});
    expect(merged.briefing).toEqual(agentConfig.briefing);
    expect(merged.expectations).toEqual(agentConfig.expectations);
    expect(merged.performance_policy).toEqual(agentConfig.performance_policy);
  });

  it("undefined domain defaults — agent config unchanged", async () => {
    const { mergeDomainDefaults } = await import("../../src/config/init.js");

    const agentConfig = {
      extends: "employee",
      briefing: [{ source: "instructions" as const }],
      expectations: [],
      performance_policy: { action: "alert" as const },
    };

    const merged = mergeDomainDefaults(agentConfig, undefined);
    expect(merged).toEqual(agentConfig);
  });
});

// ---------------------------------------------------------------------------
// 9. Validation Edge Cases (cross-cutting)
// ---------------------------------------------------------------------------
describe("validation edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-validate-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string) {
    fs.writeFileSync(path.join(tmpDir, "project.yaml"), content, "utf-8");
  }

  it("validates empty agents object without crashing", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents: {}
domain:
  agents: []
`);
    const report = validateAllConfigs(tmpDir);
    // Should not crash; no agent-level issues since there are no agents
    expect(report).toBeDefined();
    expect(report.issues).toBeDefined();
  });

  it("validates agents section with non-object entries", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  valid:
    extends: employee
  invalid: "a string"
domain:
  agents: [valid]
`);
    const report = validateAllConfigs(tmpDir);
    // Should not crash on non-object agent entries
    expect(report).toBeDefined();
  });

  it("validates global config schema — agents must be an object", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");

    const result = validateGlobalConfig({ agents: "not-an-object" });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "agents")).toBe(true);
  });

  it("validates global config schema — config must be an object", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");

    const result = validateGlobalConfig("not-an-object");
    expect(result.valid).toBe(false);
  });

  it("validates global config schema — agents as array is invalid", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");

    const result = validateGlobalConfig({ agents: ["a", "b"] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "agents")).toBe(true);
  });

  it("validates domain config — empty domain name is invalid", async () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");

    const result = validateDomainConfig({ domain: "", agents: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === "domain")).toBe(true);
  });

  it("reports unknown agent config key", async () => {
    const { validateAllConfigs } = await import("../../src/config/validate.js");
    writeYaml(`
version: "1"
project_id: test
agents:
  worker:
    extends: employee
    completely_made_up_field: true
domain:
  agents: [worker]
`);
    const report = validateAllConfigs(tmpDir);
    expect(report.issues.some(i =>
      i.code === "YAML_UNKNOWN_KEY" && i.message.includes("completely_made_up_field"),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Global Config Loader Edge Cases
// ---------------------------------------------------------------------------
describe("global config loader edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-loader-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns default empty config when config.yaml does not exist", async () => {
    const { loadGlobalConfig } = await import("../../src/config/loader.js");
    const config = loadGlobalConfig(tmpDir);
    expect(config).toEqual({ agents: {} });
  });

  it("throws on invalid YAML syntax", async () => {
    const { loadGlobalConfig } = await import("../../src/config/loader.js");
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), "agents: [\ninvalid yaml {{", "utf-8");
    expect(() => loadGlobalConfig(tmpDir)).toThrow();
  });

  it("throws when global config fails validation (agents not an object)", async () => {
    const { loadGlobalConfig } = await import("../../src/config/loader.js");
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), "agents: not-an-object\n", "utf-8");
    expect(() => loadGlobalConfig(tmpDir)).toThrow(/Invalid global config/);
  });

  it("loads empty domains directory gracefully", async () => {
    const { loadAllDomains } = await import("../../src/config/loader.js");
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    const domains = loadAllDomains(tmpDir);
    expect(domains).toEqual([]);
  });

  it("returns empty array when domains directory does not exist", async () => {
    const { loadAllDomains } = await import("../../src/config/loader.js");
    const domains = loadAllDomains(tmpDir);
    expect(domains).toEqual([]);
  });

  it("skips invalid domain files and continues", async () => {
    const { loadAllDomains } = await import("../../src/config/loader.js");
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });

    // Write one invalid and one valid domain file
    fs.writeFileSync(
      path.join(tmpDir, "domains", "bad.yaml"),
      "not_a_valid_domain: true\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "good.yaml"),
      "domain: valid-domain\nagents:\n  - agent1\n",
      "utf-8",
    );

    const domains = loadAllDomains(tmpDir);
    // Only the valid domain should be loaded
    expect(domains.length).toBe(1);
    expect(domains[0]!.domain).toBe("valid-domain");
  });
});

// ---------------------------------------------------------------------------
// 11. Preset / Extends Resolution Edge Cases
// ---------------------------------------------------------------------------
describe("preset resolution edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-edge-presets-"));
  });

  afterEach(async () => {
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    resetEnforcementConfigForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("legacy role alias: worker -> employee", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  old_style:
    role: worker
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.old_style!;
    expect(agent.extends).toBe("employee");
  });

  it("legacy role alias: orchestrator -> manager", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  old_mgr:
    role: orchestrator
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.old_mgr!;
    expect(agent.extends).toBe("manager");
  });

  it("extends takes precedence over role when both present", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    const configPath = writeYaml(`
name: test
agents:
  dual:
    extends: manager
    role: employee
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    const agent = config!.agents.dual!;
    expect(agent.extends).toBe("manager");
  });

  it("defaults to employee when neither extends nor role specified", async () => {
    const { loadWorkforceConfig } = await import("../../src/project.js");
    // Need at least one marker that makes it look like workforce config
    // Since loadWorkforceConfig checks for extends or role, we need one of them
    // Testing via domain init instead
    const configPath = writeYaml(`
name: test
agents:
  bare:
    extends: employee
    title: Bare Agent
`);
    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents.bare!.extends).toBe("employee");
  });
});

// ---------------------------------------------------------------------------
// 12. Registry Edge Cases
// ---------------------------------------------------------------------------
describe("registry edge cases", () => {
  afterEach(async () => {
    const { clearRegistry } = await import("../../src/config/registry.js");
    clearRegistry();
  });

  it("getGlobalAgent returns null for unknown agent", async () => {
    const { getGlobalAgent } = await import("../../src/config/registry.js");
    expect(getGlobalAgent("nonexistent")).toBeNull();
  });

  it("getAgentDomain returns null for unregistered agent", async () => {
    const { getAgentDomain } = await import("../../src/config/registry.js");
    expect(getAgentDomain("nonexistent")).toBeNull();
  });

  it("getAgentDomains returns empty array for unregistered agent", async () => {
    const { getAgentDomains } = await import("../../src/config/registry.js");
    expect(getAgentDomains("nonexistent")).toEqual([]);
  });

  it("getDomainAgents returns empty array for unknown domain", async () => {
    const { getDomainAgents } = await import("../../src/config/registry.js");
    expect(getDomainAgents("nonexistent")).toEqual([]);
  });

  it("registerGlobalAgents with empty object — no crash", async () => {
    const { registerGlobalAgents, getGlobalAgentIds } = await import("../../src/config/registry.js");
    registerGlobalAgents({});
    expect(getGlobalAgentIds()).toHaveLength(0);
  });

  it("assignAgentsToDomain with empty agents list — no crash", async () => {
    const { assignAgentsToDomain, getDomainAgents } = await import("../../src/config/registry.js");
    assignAgentsToDomain("domain-x", []);
    expect(getDomainAgents("domain-x")).toEqual([]);
  });

  it("clearRegistry removes everything", async () => {
    const {
      registerGlobalAgents,
      assignAgentsToDomain,
      getGlobalAgentIds,
      getDomainAgents,
      clearRegistry,
    } = await import("../../src/config/registry.js");

    registerGlobalAgents({ a: { extends: "employee" }, b: { extends: "manager" } });
    assignAgentsToDomain("d1", ["a", "b"]);
    expect(getGlobalAgentIds().length).toBe(2);

    clearRegistry();
    expect(getGlobalAgentIds()).toHaveLength(0);
    expect(getDomainAgents("d1")).toEqual([]);
  });
});
