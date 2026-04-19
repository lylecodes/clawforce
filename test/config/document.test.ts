import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("config document planning", () => {
  it("plans and applies a domain section replacement with changed paths", async () => {
    const {
      applyPlannedConfigChange,
      planDomainConfigSectionReplace,
      summarizeTopLevelChangedKeys,
    } = await import("../../src/config/document.js");
    const { readDomainConfig } = await import("../../src/config/writer.js");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-config-document-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "domains", "demo.yaml"),
      "domain: demo\nagents:\n  - lead\nbudget:\n  project:\n    dailyCents: 100\n",
    );

    const planned = planDomainConfigSectionReplace(tmpDir, "demo", "budget", {
      project: { dailyCents: 500, hourlyCents: 25 },
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.preview.valid).toBe(true);
    expect(planned.plan.changedPaths).toEqual(expect.arrayContaining(["budget.project.dailyCents", "budget.project.hourlyCents"]));
    expect(summarizeTopLevelChangedKeys(planned.plan.changedPaths)).toEqual(["budget"]);

    const result = applyPlannedConfigChange(planned.plan, "user:test");
    expect(result.ok).toBe(true);

    const persisted = readDomainConfig(tmpDir, "demo");
    expect((persisted?.budget as Record<string, unknown>)?.project).toEqual({
      dailyCents: 500,
      hourlyCents: 25,
    });
  });

  it("reports missing domains when planning", async () => {
    const { planDomainConfigMerge } = await import("../../src/config/document.js");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-config-document-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });

    const planned = planDomainConfigMerge(tmpDir, "missing", { budget: { project: { dailyCents: 100 } } });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error).toContain('Domain "missing" does not exist');
  });

  it("plans section replacement as a structural diff for arrays", async () => {
    const { planDomainConfigSectionReplace } = await import("../../src/config/document.js");

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-config-document-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "domains", "demo.yaml"),
      [
        "domain: demo",
        "agents:",
        "  - lead",
        "briefing:",
        "  - source: soul",
        "  - source: task_board",
        "",
      ].join("\n"),
      "utf-8",
    );

    const planned = planDomainConfigSectionReplace(tmpDir, "demo", "briefing", [
      { source: "soul" },
      { source: "task_board", optional: true },
      { source: "velocity" },
    ]);

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.patch.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "replace", path: ["briefing", "1", "optional"], value: true }),
      expect.objectContaining({ op: "append", path: ["briefing"], value: { source: "velocity" } }),
    ]));
    expect(planned.plan.changedPaths).toEqual(expect.arrayContaining(["briefing.1.optional", "briefing.2"]));
  });
});
