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

describe("domain-based initialization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-init-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
  });

  afterEach(async () => {
    const { clearRegistry } = await import("../../src/config/registry.js");
    const { resetEnforcementConfigForTest } = await import(
      "../../src/project.js"
    );
    clearRegistry();
    resetEnforcementConfigForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("initializes all domains from config directory", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "testdomain.yaml"),
      ["domain: testdomain", "agents:", "  - worker"].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]).toBe("testdomain");
    expect(result.errors).toHaveLength(0);
  });

  it("reports warnings for domains with undefined agents", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  worker:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "bad.yaml"),
      [
        "domain: bad",
        "agents:",
        "  - worker",
        "  - ghost-agent",
      ].join("\n"),
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("ghost-agent"))).toBe(true);
    // Should still initialize the domain (with available agents)
    expect(result.domains).toContain("bad");
  });

  it("populates existing agent config registry via bridge", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  my-bot:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "mydom.yaml"),
      ["domain: mydom", "agents:", "  - my-bot"].join("\n"),
    );

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("my-bot");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("mydom"); // domain becomes projectId in bridge
  });

  it("returns error when global config is invalid", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      "agents: not-an-object\n",
    );

    const result = initializeAllDomains(tmpDir);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.domains).toHaveLength(0);
  });

  it("resolves agent preset inheritance", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "agents:",
      "  worker:",
      "    extends: employee",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - worker",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("worker");
    expect(entry).not.toBeNull();
    // Employee preset should provide default values (e.g. title)
    expect(entry!.config.title).toBe("Employee");
  });

  it("applies global defaults when agent does not set them", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "defaults:",
      "  model: anthropic/claude-opus-4-6",
      "agents:",
      "  worker:",
      "    extends: employee",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - worker",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("worker");
    expect(entry!.config.model).toBe("anthropic/claude-opus-4-6");
  });

  it("does not override agent-level values with global defaults", async () => {
    const { initializeAllDomains } = await import("../../src/config/init.js");
    const { getAgentConfig } = await import("../../src/project.js");

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), [
      "defaults:",
      "  model: anthropic/claude-opus-4-6",
      "agents:",
      "  worker:",
      "    extends: employee",
      "    model: openai/gpt-4",
    ].join("\n"));
    fs.writeFileSync(path.join(tmpDir, "domains", "test.yaml"), [
      "domain: test",
      "agents:",
      "  - worker",
    ].join("\n"));

    initializeAllDomains(tmpDir);

    const entry = getAgentConfig("worker");
    expect(entry!.config.model).toBe("openai/gpt-4");
  });

  it("warns when no domain configs found", async () => {
    const { initializeAllDomains } = await import(
      "../../src/config/init.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  bot:", "    extends: employee"].join("\n"),
    );
    // No domain files

    const result = initializeAllDomains(tmpDir);
    expect(result.warnings).toContain("No domain configs found");
  });
});
