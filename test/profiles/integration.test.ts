import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("operational profile — config integration", () => {
  describe("DomainConfig schema", () => {
    it("accepts operational_profile field in domain config", async () => {
      const { validateDomainConfig } = await import("../../src/config/schema.js");

      const result = validateDomainConfig({
        domain: "test",
        agents: ["bot"],
        operational_profile: "medium",
      });

      expect(result.valid).toBe(true);
    });

    it("validates operational_profile value", async () => {
      const { validateDomainConfig } = await import("../../src/config/schema.js");

      // Invalid profile should still pass basic validation (it's a [key: string]: unknown)
      // but validateDomainQuality should catch it
      const result = validateDomainConfig({
        domain: "test",
        agents: ["bot"],
        operational_profile: "invalid",
      });

      // Basic validation passes (operational_profile is just a string field)
      expect(result.valid).toBe(true);
    });
  });

  describe("validateDomainQuality", () => {
    it("warns on invalid operational_profile value", async () => {
      const { validateDomainQuality } = await import("../../src/config-validator.js");

      const warnings = validateDomainQuality({
        domain: "test",
        agents: ["bot"],
        operational_profile: "invalid_profile",
      } as any);

      const profileWarning = warnings.find((w) => w.message.includes("operational_profile"));
      expect(profileWarning).toBeDefined();
      expect(profileWarning!.level).toBe("error");
    });

    it("accepts valid operational_profile values", async () => {
      const { validateDomainQuality } = await import("../../src/config-validator.js");

      for (const profile of ["low", "medium", "high", "ultra"]) {
        const warnings = validateDomainQuality({
          domain: "test",
          agents: ["bot"],
          operational_profile: profile,
          orchestrator: "lead",
          paths: ["/tmp"],
          rules: [{ name: "r", trigger: { event: "e" }, action: { agent: "a", prompt_template: "p" } }],
        } as any);

        const profileError = warnings.find(
          (w) => w.message.includes("operational_profile") && w.level === "error",
        );
        expect(profileError).toBeUndefined();
      }
    });

    it("no warning when operational_profile is absent", async () => {
      const { validateDomainQuality } = await import("../../src/config-validator.js");

      const warnings = validateDomainQuality({
        domain: "test",
        agents: ["bot"],
        orchestrator: "lead",
        paths: ["/tmp"],
        rules: [{ name: "r", trigger: { event: "e" }, action: { agent: "a", prompt_template: "p" } }],
      });

      const profileWarning = warnings.find((w) => w.message.includes("operational_profile"));
      expect(profileWarning).toBeUndefined();
    });
  });

  describe("InitAnswers + buildConfigFromAnswers", () => {
    it("includes operational_profile in init questions", async () => {
      const { getInitQuestions } = await import("../../src/config/init-flow.js");

      const questions = getInitQuestions();
      const profileQ = questions.find((q) => q.id === "operational_profile");
      expect(profileQ).toBeDefined();
      expect(profileQ!.type).toBe("choice");
      expect(profileQ!.choices).toEqual(["low", "medium", "high", "ultra"]);
    });

    it("buildConfigFromAnswers includes operational_profile in domain opts", async () => {
      const { buildConfigFromAnswers } = await import("../../src/config/init-flow.js");

      const result = buildConfigFromAnswers({
        domain_name: "test",
        mission: "Test",
        agents: [{ name: "lead", title: "Lead" }],
        reporting: {},
        budget_cents: 2000,
        operational_profile: "high",
      });

      expect(result.domain.operational_profile).toBe("high");
    });

    it("buildConfigFromAnswers omits operational_profile when not set", async () => {
      const { buildConfigFromAnswers } = await import("../../src/config/init-flow.js");

      const result = buildConfigFromAnswers({
        domain_name: "test",
        mission: "Test",
        agents: [{ name: "lead", title: "Lead" }],
        reporting: {},
        budget_cents: 2000,
      });

      expect(result.domain.operational_profile).toBeUndefined();
    });
  });

  describe("InitDomainOpts", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-profile-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("initDomain includes operational_profile in domain file", async () => {
      const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

      scaffoldConfigDir(tmpDir);
      initDomain(tmpDir, {
        name: "test-domain",
        agents: ["bot"],
        operational_profile: "medium",
      });

      const domainPath = path.join(tmpDir, "domains", "test-domain.yaml");
      const content = fs.readFileSync(domainPath, "utf-8");
      expect(content).toContain("operational_profile: medium");
    });

    it("initDomain omits operational_profile when not provided", async () => {
      const { scaffoldConfigDir, initDomain } = await import("../../src/config/wizard.js");

      scaffoldConfigDir(tmpDir);
      initDomain(tmpDir, {
        name: "test-domain",
        agents: ["bot"],
      });

      const domainPath = path.join(tmpDir, "domains", "test-domain.yaml");
      const content = fs.readFileSync(domainPath, "utf-8");
      expect(content).not.toContain("operational_profile");
    });
  });

  describe("initializeAllDomains", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-init-profile-"));
      // Clear registries
      const { clearRegistry } = await import("../../src/config/registry.js");
      clearRegistry();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("applies operational profile during domain initialization", async () => {
      const YAML = await import("yaml");
      const { initializeAllDomains } = await import("../../src/config/init.js");

      // Setup global config
      fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "config.yaml"),
        YAML.stringify({
          agents: {
            lead: { extends: "manager", title: "Lead" },
            dev: { extends: "employee", title: "Dev", reports_to: "lead" },
          },
        }),
      );

      // Setup domain with operational_profile
      fs.writeFileSync(
        path.join(tmpDir, "domains", "test.yaml"),
        YAML.stringify({
          domain: "test",
          agents: ["lead", "dev"],
          operational_profile: "medium",
        }),
      );

      const result = initializeAllDomains(tmpDir);
      expect(result.errors).toEqual([]);
      expect(result.domains).toContain("test");
    });
  });
});
