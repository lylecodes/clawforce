import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { getClawforceHome, resolveClawforceHomeHint, resolveClawforceHomes } from "../src/paths.js";

const originalCwd = process.cwd();
const originalHome = process.env.CLAWFORCE_HOME;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.CLAWFORCE_HOME;
  } else {
    process.env.CLAWFORCE_HOME = originalHome;
  }
});

describe("getClawforceHome", () => {
  it("prefers CLAWFORCE_HOME when set", () => {
    process.env.CLAWFORCE_HOME = "/tmp/custom-clawforce-home";
    expect(getClawforceHome()).toBe("/tmp/custom-clawforce-home");
  });

  it("auto-discovers a workspace-local .clawforce directory from descendant paths", () => {
    delete process.env.CLAWFORCE_HOME;
    const dir = mkdtempSync(join(tmpdir(), "clawforce-paths-"));
    try {
      const workspace = join(dir, "app");
      const nested = join(workspace, "backend", "scripts");
      mkdirSync(join(workspace, ".clawforce"), { recursive: true });
      mkdirSync(nested, { recursive: true });
      process.chdir(nested);
      expect(realpathSync(getClawforceHome())).toBe(realpathSync(join(workspace, ".clawforce")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a workspace hint to its .clawforce root", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawforce-paths-"));
    try {
      const workspace = join(dir, "app");
      const nested = join(workspace, "backend");
      mkdirSync(join(workspace, ".clawforce"), { recursive: true });
      mkdirSync(nested, { recursive: true });
      expect(realpathSync(resolveClawforceHomeHint(nested)!)).toBe(realpathSync(join(workspace, ".clawforce")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes multiple hints that resolve to the same ClawForce home", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawforce-paths-"));
    try {
      const workspace = join(dir, "app");
      mkdirSync(join(workspace, "backend"), { recursive: true });
      mkdirSync(join(workspace, ".clawforce", "nested"), { recursive: true });
      const homes = resolveClawforceHomes([
        join(workspace, ".clawforce"),
        join(workspace, "backend"),
        join(workspace, ".clawforce", "nested"),
      ]);
      expect(homes).toHaveLength(1);
      expect(realpathSync(homes[0]!)).toBe(realpathSync(join(workspace, ".clawforce")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
