import { describe, expect, it } from "vitest";

describe("config schema types", () => {
  it("validates a minimal global config", async () => {
    const { validateGlobalConfig } = await import("../../src/config/schema.js");
    const config = {
      defaults: { model: "gpt-5.4" },
      agents: {
        "my-agent": { extends: "employee" },
      },
    };
    const result = validateGlobalConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validates a minimal domain config", async () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");
    const config = {
      domain: "rentright",
      agents: ["my-agent"],
    };
    const result = validateDomainConfig(config);
    expect(result.valid).toBe(true);
  });

  it("validates a domain config with execution settings", async () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");
    const config = {
      domain: "rentright",
      agents: ["my-agent"],
      execution: {
        mode: "dry_run",
        default_mutation_policy: "simulate",
        policies: {
          tools: {
            clawforce_entity: {
              create: "allow",
              transition: "require_approval",
            },
          },
          commands: [
            { match: "npm run data:validate*", effect: "allow" },
          ],
        },
      },
    };
    const result = validateDomainConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects domain config without domain name", async () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");
    const config = { agents: ["my-agent"] } as any;
    const result = validateDomainConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("domain");
  });

  it("rejects domain config with invalid execution mode", async () => {
    const { validateDomainConfig } = await import("../../src/config/schema.js");
    const config = {
      domain: "rentright",
      agents: ["my-agent"],
      execution: {
        mode: "staging",
      },
    } as any;
    const result = validateDomainConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "execution")).toBe(true);
  });

  it("validates a rule definition", async () => {
    const { validateRuleDefinition } = await import("../../src/config/schema.js");
    const rule = {
      name: "deploy-review",
      trigger: { event: "task.completed", match: { tags: ["deploy"] } },
      action: {
        agent: "compliance-bot",
        prompt_template: "Review deployment for {{task.title}}.",
      },
    };
    const result = validateRuleDefinition(rule);
    expect(result.valid).toBe(true);
  });

  it("rejects rule without name", async () => {
    const { validateRuleDefinition } = await import("../../src/config/schema.js");
    const rule = {
      trigger: { event: "task.completed" },
      action: { agent: "bot", prompt_template: "hi" },
    } as any;
    const result = validateRuleDefinition(rule);
    expect(result.valid).toBe(false);
  });
});
