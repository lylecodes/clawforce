import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveToolsDocs, resolveSoulDoc } from "../../src/context/sources/agent-docs.js";
import { ensureAgentDocs } from "../../src/context/sources/auto-generate.js";
import { generateSoulTemplate, isSoulTemplateUnmodified } from "../../src/context/sources/auto-generate.js";
import type { AgentConfig } from "../../src/types.js";

function makeConfig(role: AgentConfig["role"]): AgentConfig {
  return {
    role,
    briefing: [],
    expectations: [],
    performance_policy: { action: "alert" },
  };
}

describe("agent-docs resolvers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-docs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolveToolsDocs", () => {
    it("auto-generates from role scope when no file on disk", () => {
      const content = resolveToolsDocs("frontend-dev", makeConfig("employee"), tmpDir);

      expect(content).not.toBeNull();
      expect(content).toContain("Your Tools");
      expect(content).toContain("clawforce_task");
      expect(content).toContain("clawforce_log");
      // Employee should not see manager-only tools
      expect(content).not.toContain("clawforce_ops");
      expect(content).not.toContain("clawforce_workflow");
    });

    it("loads from disk when TOOLS.md exists", () => {
      const agentDir = path.join(tmpDir, "agents", "frontend-dev");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "TOOLS.md"), "# Custom Tools\n\nCustom tool documentation here.", "utf-8");

      const content = resolveToolsDocs("frontend-dev", makeConfig("employee"), tmpDir);

      expect(content).toBe("# Custom Tools\n\nCustom tool documentation here.");
    });

    it("disk file takes precedence over auto-generated", () => {
      const agentDir = path.join(tmpDir, "agents", "frontend-dev");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "TOOLS.md"), "Custom override", "utf-8");

      const content = resolveToolsDocs("frontend-dev", makeConfig("employee"), tmpDir);

      expect(content).toBe("Custom override");
      // Should NOT contain auto-generated content
      expect(content).not.toContain("clawforce_task");
    });

    it("auto-generates for scheduled role with restricted tools", () => {
      const content = resolveToolsDocs("daily-sweep", makeConfig("scheduled"), tmpDir);

      expect(content).not.toBeNull();
      expect(content).toContain("clawforce_log");
      expect(content).not.toContain("clawforce_task");
      expect(content).not.toContain("clawforce_ops");
    });

    it("auto-generates for manager role with all tools", () => {
      const content = resolveToolsDocs("boss", makeConfig("manager"), tmpDir);

      expect(content).not.toBeNull();
      expect(content).toContain("clawforce_task");
      expect(content).toContain("clawforce_ops");
      expect(content).toContain("clawforce_workflow");
    });

    it("works without projectDir (auto-generates)", () => {
      const content = resolveToolsDocs("agent1", makeConfig("employee"), undefined);

      expect(content).not.toBeNull();
      expect(content).toContain("Your Tools");
    });

    it("truncates files larger than 10KB", () => {
      const agentDir = path.join(tmpDir, "agents", "big-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const bigContent = "x".repeat(15_000);
      fs.writeFileSync(path.join(agentDir, "TOOLS.md"), bigContent, "utf-8");

      const content = resolveToolsDocs("big-agent", makeConfig("employee"), tmpDir);

      expect(content!.length).toBeLessThan(15_000);
      expect(content).toContain("…(truncated)");
    });

    it("accepts optional projectId parameter for effective scope resolution", () => {
      // Without projectId, falls back to role defaults (same as before)
      const content = resolveToolsDocs("agent1", makeConfig("employee"), tmpDir);
      expect(content).not.toBeNull();
      expect(content).toContain("clawforce_task");

      // With projectId but no policies registered, should still use role defaults
      const contentWithProjectId = resolveToolsDocs("agent1", makeConfig("employee"), tmpDir, "proj1");
      expect(contentWithProjectId).not.toBeNull();
      expect(contentWithProjectId).toContain("clawforce_task");
    });
  });

  describe("resolveSoulDoc", () => {
    it("returns null when SOUL.md does not exist", () => {
      const content = resolveSoulDoc("frontend-dev", tmpDir);
      expect(content).toBeNull();
    });

    it("returns content when SOUL.md exists", () => {
      const agentDir = path.join(tmpDir, "agents", "frontend-dev");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "SOUL.md"),
        "You are a senior frontend engineer specializing in React and TypeScript.",
        "utf-8",
      );

      const content = resolveSoulDoc("frontend-dev", tmpDir);

      expect(content).toBe("You are a senior frontend engineer specializing in React and TypeScript.");
    });

    it("returns null when projectDir is undefined", () => {
      const content = resolveSoulDoc("frontend-dev", undefined);
      expect(content).toBeNull();
    });

    it("returns null for empty SOUL.md", () => {
      const agentDir = path.join(tmpDir, "agents", "frontend-dev");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "SOUL.md"), "   \n  ", "utf-8");

      const content = resolveSoulDoc("frontend-dev", tmpDir);
      expect(content).toBeNull();
    });

    it("truncates SOUL.md larger than 10KB", () => {
      const agentDir = path.join(tmpDir, "agents", "verbose-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const bigContent = "y".repeat(15_000);
      fs.writeFileSync(path.join(agentDir, "SOUL.md"), bigContent, "utf-8");

      const content = resolveSoulDoc("verbose-agent", tmpDir);

      expect(content!.length).toBeLessThan(15_000);
      expect(content).toContain("…(truncated)");
    });
  });

  describe("path traversal protection", () => {
    it("rejects agentId with ..", () => {
      const content = resolveToolsDocs("../../../etc", makeConfig("employee"), tmpDir);
      // Should fall through to auto-generation (no disk read attempted)
      expect(content).not.toBeNull();
      expect(content).toContain("Your Tools");
    });

    it("rejects agentId with slashes", () => {
      const content = resolveSoulDoc("agent/../../etc/passwd", tmpDir);
      expect(content).toBeNull();
    });

    it("rejects agentId with backslashes", () => {
      const content = resolveSoulDoc("agent\\..\\..\\etc", tmpDir);
      expect(content).toBeNull();
    });
  });
});

describe("ensureAgentDocs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-docs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates agent directory and SOUL.md template", () => {
    ensureAgentDocs(tmpDir, "frontend-dev", makeConfig("employee"));

    const soulPath = path.join(tmpDir, "agents", "frontend-dev", "SOUL.md");
    expect(fs.existsSync(soulPath)).toBe(true);

    const content = fs.readFileSync(soulPath, "utf-8");
    expect(content).toContain("<!-- SOUL.md");
    expect(content).toContain("frontend-dev");
  });

  it("does not create TOOLS.md on disk", () => {
    ensureAgentDocs(tmpDir, "frontend-dev", makeConfig("employee"));

    const toolsPath = path.join(tmpDir, "agents", "frontend-dev", "TOOLS.md");
    expect(fs.existsSync(toolsPath)).toBe(false);
  });

  it("does not overwrite existing SOUL.md", () => {
    const agentDir = path.join(tmpDir, "agents", "frontend-dev");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "SOUL.md"), "Custom persona content", "utf-8");

    ensureAgentDocs(tmpDir, "frontend-dev", makeConfig("employee"));

    const content = fs.readFileSync(path.join(agentDir, "SOUL.md"), "utf-8");
    expect(content).toBe("Custom persona content");
  });

  it("skips agentId with path traversal", () => {
    ensureAgentDocs(tmpDir, "../escape", makeConfig("employee"));

    // Should not have created any directory outside agents/
    expect(fs.existsSync(path.join(tmpDir, "agents"))).toBe(false);
  });

  it("SOUL.md template contains expected marker", () => {
    ensureAgentDocs(tmpDir, "test-agent", makeConfig("employee"));

    const soulPath = path.join(tmpDir, "agents", "test-agent", "SOUL.md");
    const content = fs.readFileSync(soulPath, "utf-8");
    expect(content.startsWith("<!-- SOUL.md")).toBe(true);
    expect(isSoulTemplateUnmodified(content)).toBe(true);
  });
});

describe("generateSoulTemplate", () => {
  it("includes agent ID in template", () => {
    const template = generateSoulTemplate("my-agent");
    expect(template).toContain("my-agent");
    expect(template).toContain("<!-- SOUL.md");
    expect(template).toContain("Expertise");
    expect(template).toContain("Guidelines");
  });
});

describe("isSoulTemplateUnmodified", () => {
  it("returns true for generated template", () => {
    const template = generateSoulTemplate("agent1");
    expect(isSoulTemplateUnmodified(template)).toBe(true);
  });

  it("returns false for customized content", () => {
    expect(isSoulTemplateUnmodified("# My Custom Agent\n\nI specialize in...")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSoulTemplateUnmodified("")).toBe(false);
  });
});
