import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

import { loadWorkforceConfig } from "../../src/project.js";

describe("skill packs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-packs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges skill_pack briefing into agent config", () => {
    const yaml = `
name: test-project
id: test
dir: .

skill_packs:
  code_reviewer:
    briefing:
      - source: file
        path: "docs/review-checklist.md"
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 2

agents:
  reviewer:
    extends: employee
    skill_pack: code_reviewer
`;
    const configPath = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(configPath, yaml, "utf-8");

    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();

    const reviewer = config!.agents.reviewer!;
    expect(reviewer.skill_pack).toBe("code_reviewer");

    // Pack briefing should be merged
    const fileSources = reviewer.briefing.filter((s) => s.source === "file");
    expect(fileSources.length).toBeGreaterThanOrEqual(1);
    const reviewChecklist = fileSources.find((s) => s.path === "docs/review-checklist.md");
    expect(reviewChecklist).toBeTruthy();
  });

  it("stores skill_packs on WorkforceConfig", () => {
    const yaml = `
name: test
id: test
dir: .

skill_packs:
  my_pack:
    briefing:
      - source: custom
        content: "hello"
    expectations:
      - tool: clawforce_log
        action: outcome
        min_calls: 1

agents:
  agent1:
    extends: employee
`;
    const configPath = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(configPath, yaml, "utf-8");

    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.skill_packs).toBeDefined();
    expect(config!.skill_packs!.my_pack).toBeDefined();
    expect(config!.skill_packs!.my_pack.expectations).toHaveLength(1);
  });

  it("agent without skill_pack is unaffected", () => {
    const yaml = `
name: test
id: test
dir: .

skill_packs:
  my_pack:
    briefing:
      - source: custom
        content: "hello"

agents:
  agent1:
    extends: employee
`;
    const configPath = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(configPath, yaml, "utf-8");

    const config = loadWorkforceConfig(configPath);
    const agent = config!.agents.agent1!;
    expect(agent.skill_pack).toBeUndefined();
    // Should not have custom source from pack
    const customSources = agent.briefing.filter((s) => s.source === "custom");
    expect(customSources).toHaveLength(0);
  });
});
