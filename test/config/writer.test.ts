import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
  safeLog: vi.fn(),
}));

const {
  readGlobalConfig,
  writeGlobalConfig,
  updateGlobalConfig,
  readDomainConfig,
  writeDomainConfig,
  updateDomainConfig,
  deleteDomainConfig,
  upsertGlobalAgent,
  removeGlobalAgent,
  updateGlobalAgent,
  addAgentToDomain,
  removeAgentFromDomain,
  setDomainSection,
  previewGlobalChange,
  previewDomainChange,
  deepMerge,
} = await import("../../src/config/writer.js");

const { emitDiagnosticEvent } = await import("../../src/diagnostics.js");

describe("config writer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-writer-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  function writeConfig(agents: Record<string, unknown> = {}) {
    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      YAML.stringify({ agents }),
      "utf-8",
    );
  }

  function writeDomain(name: string, config: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(tmpDir, "domains", `${name}.yaml`),
      YAML.stringify({ domain: name, ...config }),
      "utf-8",
    );
  }

  // --- deepMerge ---

  describe("deepMerge", () => {
    it("merges flat objects", () => {
      const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("deep merges nested objects", () => {
      const result = deepMerge(
        { nested: { a: 1, b: 2 } },
        { nested: { b: 3, c: 4 } },
      );
      expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
    });

    it("replaces arrays", () => {
      const result = deepMerge({ arr: [1, 2] }, { arr: [3] });
      expect(result).toEqual({ arr: [3] });
    });

    it("deletes keys set to null", () => {
      const result = deepMerge({ a: 1, b: 2 }, { b: null });
      expect(result).toEqual({ a: 1 });
    });

    it("skips undefined values", () => {
      const result = deepMerge({ a: 1 }, { a: undefined, b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  // --- Global config ---

  describe("global config", () => {
    it("reads default empty config when file missing", () => {
      const config = readGlobalConfig(tmpDir);
      expect(config.agents).toEqual({});
    });

    it("reads existing config", () => {
      writeConfig({ bot: { extends: "employee" } });
      const config = readGlobalConfig(tmpDir);
      expect(config.agents.bot).toBeDefined();
    });

    it("writes and validates global config", () => {
      const result = writeGlobalConfig(tmpDir, { agents: { a: { extends: "manager" } } });
      expect(result.ok).toBe(true);

      const config = readGlobalConfig(tmpDir);
      expect(config.agents.a).toBeDefined();
    });

    it("rejects invalid global config", () => {
      const result = writeGlobalConfig(tmpDir, { agents: "invalid" } as any);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Validation");
    });

    it("updates global config with field merge", () => {
      writeConfig({ bot: { extends: "employee" } });

      const result = updateGlobalConfig(
        tmpDir,
        { defaults: { performance_policy: { action: "retry" } } },
        "test-actor",
      );

      expect(result.ok).toBe(true);
      expect(result.diff).toBeDefined();

      const config = readGlobalConfig(tmpDir);
      expect(config.defaults?.performance_policy?.action).toBe("retry");
      expect(config.agents.bot).toBeDefined(); // preserved
    });

    it("emits event on global update", () => {
      writeConfig({});
      updateGlobalConfig(tmpDir, { defaults: {} }, "bot-1");

      expect(emitDiagnosticEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "config_updated",
          actor: "bot-1",
          section: "global",
        }),
      );
    });
  });

  // --- Domain config ---

  describe("domain config", () => {
    it("reads null for missing domain", () => {
      expect(readDomainConfig(tmpDir, "ghost")).toBeNull();
    });

    it("reads existing domain", () => {
      writeDomain("proj", { agents: ["a"] });
      const config = readDomainConfig(tmpDir, "proj");
      expect(config).not.toBeNull();
      expect(config!.domain).toBe("proj");
    });

    it("writes and validates domain config", () => {
      const result = writeDomainConfig(tmpDir, "proj", {
        domain: "proj",
        agents: ["a"],
      });
      expect(result.ok).toBe(true);
    });

    it("rejects invalid domain config", () => {
      const result = writeDomainConfig(tmpDir, "bad", {
        domain: "",
        agents: [],
      } as any);
      expect(result.ok).toBe(false);
    });

    it("updates domain config with field merge", () => {
      writeDomain("proj", { agents: ["a"], budget: { project: { dailyCents: 100 } } });

      const result = updateDomainConfig(
        tmpDir, "proj",
        { orchestrator: "a" },
        "actor",
      );

      expect(result.ok).toBe(true);
      const config = readDomainConfig(tmpDir, "proj")!;
      expect(config.orchestrator).toBe("a");
      expect(config.agents).toEqual(["a"]); // preserved
      expect(config.budget).toBeDefined(); // preserved
    });

    it("preserves domain name on update", () => {
      writeDomain("proj", { agents: ["a"] });
      updateDomainConfig(tmpDir, "proj", { domain: "sneaky" }, "actor");
      const config = readDomainConfig(tmpDir, "proj")!;
      expect(config.domain).toBe("proj"); // not changed
    });

    it("deletes domain config", () => {
      writeDomain("doomed", { agents: ["a"] });

      const result = deleteDomainConfig(tmpDir, "doomed", "actor");
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "domains", "doomed.yaml"))).toBe(false);
    });

    it("fails to delete non-existent domain", () => {
      const result = deleteDomainConfig(tmpDir, "ghost", "actor");
      expect(result.ok).toBe(false);
    });

    it("fails to update non-existent domain", () => {
      const result = updateDomainConfig(tmpDir, "ghost", {}, "actor");
      expect(result.ok).toBe(false);
    });
  });

  // --- Agent operations ---

  describe("agent operations", () => {
    it("upserts a new agent", () => {
      writeConfig({});
      const result = upsertGlobalAgent(tmpDir, "bot", { extends: "employee" }, "actor");
      expect(result.ok).toBe(true);

      const config = readGlobalConfig(tmpDir);
      expect(config.agents.bot?.extends).toBe("employee");
    });

    it("upserts existing agent (overwrite)", () => {
      writeConfig({ bot: { extends: "employee", title: "Old" } });
      const result = upsertGlobalAgent(tmpDir, "bot", { extends: "manager", title: "New" }, "actor");
      expect(result.ok).toBe(true);

      const config = readGlobalConfig(tmpDir);
      expect(config.agents.bot?.extends).toBe("manager");
      expect(config.agents.bot?.title).toBe("New");
    });

    it("removes agent from global config", () => {
      writeConfig({ bot: { extends: "employee" }, keeper: { extends: "manager" } });
      const result = removeGlobalAgent(tmpDir, "bot", false, "actor");
      expect(result.ok).toBe(true);

      const config = readGlobalConfig(tmpDir);
      expect(config.agents.bot).toBeUndefined();
      expect(config.agents.keeper).toBeDefined();
    });

    it("removes agent from domains too", () => {
      writeConfig({ bot: { extends: "employee" } });
      writeDomain("proj", { agents: ["bot", "other"], orchestrator: "bot" });

      const result = removeGlobalAgent(tmpDir, "bot", true, "actor");
      expect(result.ok).toBe(true);

      const domain = readDomainConfig(tmpDir, "proj")!;
      expect(domain.agents.includes("bot")).toBe(false);
      expect(domain.agents.includes("other")).toBe(true);
      expect(domain.orchestrator).toBeUndefined(); // cleared because was bot
    });

    it("fails to remove non-existent agent", () => {
      writeConfig({});
      const result = removeGlobalAgent(tmpDir, "ghost", false, "actor");
      expect(result.ok).toBe(false);
    });

    it("updates agent fields via merge", () => {
      writeConfig({ bot: { extends: "employee", title: "Worker", department: "eng" } });

      const result = updateGlobalAgent(tmpDir, "bot", { title: "Senior Worker", model: "opus" }, "actor");
      expect(result.ok).toBe(true);

      const config = readGlobalConfig(tmpDir);
      expect(config.agents.bot?.title).toBe("Senior Worker");
      expect((config.agents.bot as any).model).toBe("opus");
      expect((config.agents.bot as any).department).toBe("eng"); // preserved
    });

    it("fails to update non-existent agent", () => {
      writeConfig({});
      const result = updateGlobalAgent(tmpDir, "ghost", {}, "actor");
      expect(result.ok).toBe(false);
    });

    it("adds agent to domain", () => {
      writeDomain("proj", { agents: ["a"] });
      const result = addAgentToDomain(tmpDir, "proj", "b", "actor");
      expect(result.ok).toBe(true);

      const domain = readDomainConfig(tmpDir, "proj")!;
      expect(domain.agents).toContain("b");
    });

    it("adding agent to domain is idempotent", () => {
      writeDomain("proj", { agents: ["a"] });
      const result = addAgentToDomain(tmpDir, "proj", "a", "actor");
      expect(result.ok).toBe(true);

      const domain = readDomainConfig(tmpDir, "proj")!;
      expect(domain.agents.length).toBe(1); // not duplicated
    });

    it("removes agent from domain", () => {
      writeDomain("proj", { agents: ["a", "b"], orchestrator: "a" });
      const result = removeAgentFromDomain(tmpDir, "proj", "a", "actor");
      expect(result.ok).toBe(true);

      const domain = readDomainConfig(tmpDir, "proj")!;
      expect(domain.agents).toEqual(["b"]);
      expect(domain.orchestrator).toBeUndefined(); // cleared
    });

    it("removing agent from domain is idempotent", () => {
      writeDomain("proj", { agents: ["a"] });
      const result = removeAgentFromDomain(tmpDir, "proj", "missing", "actor");
      expect(result.ok).toBe(true);
    });
  });

  // --- Section operations ---

  describe("section operations", () => {
    it("sets domain section", () => {
      writeDomain("proj", { agents: ["a"] });
      const result = setDomainSection(tmpDir, "proj", "channels", [{ name: "general" }], "actor");
      expect(result.ok).toBe(true);

      const domain = readDomainConfig(tmpDir, "proj")!;
      expect(domain.channels).toEqual([{ name: "general" }]);
    });
  });

  // --- Preview (diff) ---

  describe("preview", () => {
    it("previews global change without writing", () => {
      writeConfig({ bot: { extends: "employee" } });

      const preview = previewGlobalChange(tmpDir, {
        agents: { bot: { extends: "manager" } },
      });

      expect(preview.valid).toBe(true);
      expect((preview.before.agents as any).bot.extends).toBe("employee");
      expect((preview.after.agents as any).bot.extends).toBe("manager");

      // Verify original file unchanged
      const config = readGlobalConfig(tmpDir);
      expect(config.agents.bot?.extends).toBe("employee");
    });

    it("previews domain change without writing", () => {
      writeDomain("proj", { agents: ["a"], budget: { dailyCents: 100 } });

      const preview = previewDomainChange(tmpDir, "proj", {
        budget: { dailyCents: 500 },
      });

      expect(preview.valid).toBe(true);
      expect((preview.before.budget as any).dailyCents).toBe(100);
      expect((preview.after.budget as any).dailyCents).toBe(500);
    });

    it("reports validation errors in preview", () => {
      writeDomain("proj", { agents: ["a"] });

      const preview = previewDomainChange(tmpDir, "proj", {
        agents: "not-an-array",
      });

      expect(preview.valid).toBe(false);
      expect(preview.errors!.length).toBeGreaterThan(0);
    });
  });
});
