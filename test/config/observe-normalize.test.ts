import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { loadWorkforceConfig } = await import("../../src/project.js");

describe("observe field normalization", () => {
  it("preserves observe field from YAML config", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-test-"));
    const configPath = join(dir, "workforce.yaml");
    writeFileSync(configPath, `
name: test-observe
agents:
  budget-ops:
    extends: employee
    title: Budget Ops
    reports_to: lead
    observe:
      - budget.exceeded
      - budget.warning
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
  lead:
    extends: manager
    title: Lead
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents["budget-ops"].observe).toEqual(["budget.exceeded", "budget.warning"]);
  });

  it("handles missing observe field", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-test-"));
    const configPath = join(dir, "workforce.yaml");
    writeFileSync(configPath, `
name: test-no-observe
agents:
  dev:
    extends: employee
    title: Dev
    reports_to: lead
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_task
        action: transition
        min_calls: 1
  lead:
    extends: manager
    title: Lead
    briefing:
      - source: instructions
    expectations:
      - tool: clawforce_log
        action: write
        min_calls: 1
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.agents["dev"].observe).toBeUndefined();
  });
});
