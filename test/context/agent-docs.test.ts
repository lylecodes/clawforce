import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveToolsDocs, resolveSoulDoc } from "../../src/context/sources/agent-docs.js";
import { ensureAgentDocs } from "../../src/context/sources/auto-generate.js";
import { generateSoulTemplate, isSoulTemplateUnmodified } from "../../src/context/sources/auto-generate.js";
import type { AgentConfig } from "../../src/types.js";

function makeConfig(preset: string): AgentConfig {
  return {
    extends: preset,
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
      // Employee has no clawforce tools (auto-lifecycle)
      expect(content).not.toContain("clawforce_task");
      expect(content).not.toContain("clawforce_log");
      expect(content).not.toContain("clawforce_ops");
      expect(content).not.toContain("clawforce_workflow");
      // But has memory tools
      expect(content).toContain("memory_search");
      expect(content).toContain("memory_get");
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

    it("returns null for unknown preset with no scope", () => {
      const content = resolveToolsDocs("daily-sweep", makeConfig("custom-preset"), tmpDir);

      // Unknown presets have no entry in DEFAULT_ACTION_SCOPES, so auto-generation returns null
      expect(content).toBeNull();
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
      expect(content).toContain("memory_search");

      // With projectId but no policies registered, should still use role defaults
      const contentWithProjectId = resolveToolsDocs("agent1", makeConfig("employee"), tmpDir, "proj1");
      expect(contentWithProjectId).not.toBeNull();
      expect(contentWithProjectId).toContain("memory_search");
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

    // --- Per-role SOUL resolution ---

    it("returns role SOUL when only SOUL-{role}.md exists", () => {
      fs.writeFileSync(
        path.join(tmpDir, "SOUL-manager.md"),
        "You are a manager. You coordinate work across teams.",
        "utf-8",
      );

      const content = resolveSoulDoc("some-agent", tmpDir, "manager");

      expect(content).toBe("You are a manager. You coordinate work across teams.");
    });

    it("returns agent SOUL when only agent SOUL.md exists (no role SOUL)", () => {
      const agentDir = path.join(tmpDir, "agents", "frontend-dev");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "SOUL.md"),
        "Agent-specific persona.",
        "utf-8",
      );

      const content = resolveSoulDoc("frontend-dev", tmpDir, "employee");

      expect(content).toBe("Agent-specific persona.");
    });

    it("layers role SOUL and agent SOUL when both exist", () => {
      // Role SOUL
      fs.writeFileSync(
        path.join(tmpDir, "SOUL-employee.md"),
        "You are an employee. Follow standards and deliver quality work.",
        "utf-8",
      );

      // Agent SOUL
      const agentDir = path.join(tmpDir, "agents", "frontend-dev");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "SOUL.md"),
        "Specializes in React and TypeScript. Prefers functional components.",
        "utf-8",
      );

      const content = resolveSoulDoc("frontend-dev", tmpDir, "employee");

      expect(content).not.toBeNull();
      // Role SOUL comes first
      expect(content).toContain("You are an employee. Follow standards and deliver quality work.");
      // Separator heading
      expect(content).toContain("## Agent-Specific Context");
      // Agent SOUL comes after
      expect(content).toContain("Specializes in React and TypeScript. Prefers functional components.");
      // Verify ordering: role before agent
      const roleIdx = content!.indexOf("You are an employee");
      const agentIdx = content!.indexOf("Specializes in React");
      expect(roleIdx).toBeLessThan(agentIdx);
    });

    it("returns null when neither role SOUL nor agent SOUL exist", () => {
      const content = resolveSoulDoc("ghost-agent", tmpDir, "employee");
      expect(content).toBeNull();
    });

    it("ignores role SOUL when role is undefined", () => {
      fs.writeFileSync(
        path.join(tmpDir, "SOUL-manager.md"),
        "Manager role soul.",
        "utf-8",
      );

      const content = resolveSoulDoc("some-agent", tmpDir, undefined);
      // No agent SOUL and no role lookup → null
      expect(content).toBeNull();
    });

    it("ignores role SOUL when role is undefined but returns agent SOUL", () => {
      fs.writeFileSync(
        path.join(tmpDir, "SOUL-manager.md"),
        "Manager role soul.",
        "utf-8",
      );
      const agentDir = path.join(tmpDir, "agents", "some-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "SOUL.md"), "Agent soul only.", "utf-8");

      const content = resolveSoulDoc("some-agent", tmpDir, undefined);
      // Only agent SOUL, role SOUL not looked up
      expect(content).toBe("Agent soul only.");
    });

    it("handles empty role SOUL file gracefully (falls back to agent only)", () => {
      fs.writeFileSync(path.join(tmpDir, "SOUL-verifier.md"), "   \n  ", "utf-8");

      const agentDir = path.join(tmpDir, "agents", "qa-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "SOUL.md"), "QA persona.", "utf-8");

      const content = resolveSoulDoc("qa-agent", tmpDir, "verifier");
      expect(content).toBe("QA persona.");
    });

    it("handles path traversal in role parameter", () => {
      const content = resolveSoulDoc("some-agent", tmpDir, "../../etc");
      expect(content).toBeNull();
    });

    it("truncates combined layered SOUL when it exceeds 10KB", () => {
      // Role SOUL close to limit
      const roleSoul = "R".repeat(6000);
      fs.writeFileSync(path.join(tmpDir, "SOUL-employee.md"), roleSoul, "utf-8");

      // Agent SOUL also large
      const agentDir = path.join(tmpDir, "agents", "big-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const agentSoul = "A".repeat(6000);
      fs.writeFileSync(path.join(agentDir, "SOUL.md"), agentSoul, "utf-8");

      const content = resolveSoulDoc("big-agent", tmpDir, "employee");
      // Combined would be > 12000 chars, should be truncated to MAX_DOC_SIZE (10240)
      expect(content!.length).toBeLessThanOrEqual(10240 + 20); // +20 for truncation marker
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
