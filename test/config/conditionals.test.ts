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

describe("resolveConditionals unit tests", () => {
  it("resolves a matching when clause", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channels: {
        when: [
          { match: { department: "sales" }, value: ["sales-channel"] },
          { match: { department: "engineering" }, value: ["eng-channel"] },
          { default: ["general"] },
        ],
      },
      title: "Rep",
    };
    const context = { department: "sales" };
    const result = resolveConditionals(config, context);
    expect(result.channels).toEqual(["sales-channel"]);
    expect(result.title).toBe("Rep");
  });

  it("falls back to default when no match", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channels: {
        when: [
          { match: { department: "sales" }, value: ["sales-channel"] },
          { default: ["general"] },
        ],
      },
    };
    const context = { department: "hr" };
    const result = resolveConditionals(config, context);
    expect(result.channels).toEqual(["general"]);
  });

  it("omits field when no match and no default", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channels: {
        when: [
          { match: { department: "sales" }, value: ["sales-channel"] },
        ],
      },
      title: "Agent",
    };
    const context = { department: "hr" };
    const result = resolveConditionals(config, context);
    expect(result.channels).toBeUndefined();
    expect(result.title).toBe("Agent");
  });

  it("handles multi-key match (all keys must match)", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      tools: {
        when: [
          { match: { department: "engineering", team: "frontend" }, value: ["eslint", "prettier"] },
          { match: { department: "engineering" }, value: ["eslint"] },
          { default: [] },
        ],
      },
    };

    const result1 = resolveConditionals(config, { department: "engineering", team: "frontend" });
    expect(result1.tools).toEqual(["eslint", "prettier"]);

    const result2 = resolveConditionals(config, { department: "engineering", team: "backend" });
    expect(result2.tools).toEqual(["eslint"]);

    const result3 = resolveConditionals(config, { department: "sales" });
    expect(result3.tools).toEqual([]);
  });

  it("supports array values in match (any-of)", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      channel: {
        when: [
          { match: { department: ["sales", "marketing"] }, value: "biz-channel" },
          { default: "general" },
        ],
      },
    };

    const result1 = resolveConditionals(config, { department: "sales" });
    expect(result1.channel).toBe("biz-channel");

    const result2 = resolveConditionals(config, { department: "marketing" });
    expect(result2.channel).toBe("biz-channel");

    const result3 = resolveConditionals(config, { department: "engineering" });
    expect(result3.channel).toBe("general");
  });

  it("recurses into nested objects", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      scheduling: {
        adaptiveWake: true,
        wakeBounds: {
          when: [
            { match: { extends: "manager" }, value: ["*/15 * * * *", "*/60 * * * *"] },
            { default: ["*/30 * * * *", "*/120 * * * *"] },
          ],
        },
      },
    };

    const result = resolveConditionals(config, { extends: "manager" });
    expect((result.scheduling as Record<string, unknown>).adaptiveWake).toBe(true);
    expect((result.scheduling as Record<string, unknown>).wakeBounds).toEqual(["*/15 * * * *", "*/60 * * * *"]);
  });

  it("passes through non-when objects and arrays unchanged", async () => {
    const { resolveConditionals } = await import("../../src/config/conditionals.js");

    const config = {
      briefing: ["soul", "tools_reference"],
      performance_policy: { action: "retry", max_retries: 2 },
      title: "Worker",
    };
    const result = resolveConditionals(config, {});
    expect(result).toEqual(config);
  });
});

describe("conditional config integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-cond-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
  });

  afterEach(async () => {
    const { clearRegistry } = await import("../../src/config/registry.js");
    const { resetEnforcementConfigForTest } = await import("../../src/project.js");
    clearRegistry();
    resetEnforcementConfigForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("resolves conditional channels based on department during init", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  sales-rep:",
      "    extends: employee",
      "    department: sales",
      "    channel:",
      "      when:",
      "        - match: { department: sales }",
      "          value: sales-channel",
      "        - default: general",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - sales-rep",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("sales-rep");
    expect(entry).not.toBeNull();
    expect(entry!.config.channel).toBe("sales-channel");
  });

  it("resolves conditional to default when no match", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  hr-rep:",
      "    extends: employee",
      "    department: hr",
      "    channel:",
      "      when:",
      "        - match: { department: sales }",
      "          value: sales-channel",
      "        - default: general",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - hr-rep",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("hr-rep");
    expect(entry).not.toBeNull();
    expect(entry!.config.channel).toBe("general");
  });
});
