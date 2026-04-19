/**
 * Onboarding integration test — validates the complete config pipeline.
 * Write config.yaml + domains/*.yaml → validate → load → register → verify agents are known.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { validateAllConfigs } = await import("../../src/config/validate.js");
const { loadWorkforceConfig, getAgentConfig, getRegisteredAgentIds, resetEnforcementConfigForTest, registerWorkforceConfig } = await import("../../src/project.js");
const { validateWorkforceConfig } = await import("../../src/config-validator.js");

describe("onboarding pipeline e2e", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-onboard-"));
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetEnforcementConfigForTest();
  });

  it("complete onboarding: write config → validate → load → register → verify", () => {
    // 1. Write a minimal but realistic split config
    const globalYaml = `
agents:
  proj-lead:
    extends: manager
    title: Project Lead

  proj-worker:
    extends: employee
    title: Developer
    expectations: []
`;

    const domainYaml = `
domain: my-project
paths:
  - ${tmpDir}
agents:
  - proj-lead
  - proj-worker
manager:
  agentId: proj-lead
`;

    fs.writeFileSync(path.join(tmpDir, "config.yaml"), globalYaml, "utf-8");
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "domains", "my-project.yaml"), domainYaml, "utf-8");

    // 2. Validate — should pass with no errors
    const validationReport = validateAllConfigs(tmpDir);
    expect(validationReport.valid).toBe(true);
    const errors = validationReport.issues.filter(i => i.severity === "error");
    expect(errors).toHaveLength(0);

    // 3. Load workforce config
    const wfConfig = loadWorkforceConfig(path.join(tmpDir, "config.yaml"));
    expect(wfConfig).not.toBeNull();
    expect(wfConfig!.agents).toHaveProperty("proj-lead");
    expect(wfConfig!.agents).toHaveProperty("proj-worker");

    // 4. Validate workforce config
    const warnings = validateWorkforceConfig(wfConfig!);
    const wfErrors = warnings.filter(w => w.level === "error");
    expect(wfErrors).toHaveLength(0);

    // 5. Register — agents become available in the system
    registerWorkforceConfig("my-project", wfConfig!, tmpDir);

    // 6. Verify — agents are registered and retrievable
    const agentIds = getRegisteredAgentIds();
    expect(agentIds).toContain("proj-lead");
    expect(agentIds).toContain("proj-worker");

    // 7. Verify config resolution worked
    const leadConfig = getAgentConfig("proj-lead");
    expect(leadConfig).not.toBeNull();
    expect(leadConfig!.config.extends).toBe("manager");
    expect(leadConfig!.config.title).toBe("Project Lead");

    const workerConfig = getAgentConfig("proj-worker");
    expect(workerConfig).not.toBeNull();
    expect(workerConfig!.config.extends).toBe("employee");
    // Worker explicitly set expectations: [] — should remain empty
    expect(workerConfig!.config.expectations).toHaveLength(0);
  });

  it("rejects invalid config during onboarding", () => {
    const badGlobalYaml = `
agents:
  lead:
    extends: manager
`;
    const badDomainYaml = `
domain: bad-project
agents: [lead, nonexistent]
`;
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), badGlobalYaml, "utf-8");
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "domains", "bad-project.yaml"), badDomainYaml, "utf-8");

    const report = validateAllConfigs(tmpDir);
    expect(report.valid).toBe(false);
    expect(report.issues.some(i => i.code === "DOMAIN_AGENT_NOT_GLOBAL")).toBe(true);
  });
});
