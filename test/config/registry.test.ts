import { afterEach, describe, expect, it } from "vitest";

describe("agent global roster registry", () => {
  afterEach(async () => {
    const { clearRegistry } = await import("../../src/config/registry.js");
    clearRegistry();
  });

  it("registers global agents and assigns them to domains", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getAgentDomain, getGlobalAgent } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "compliance-bot": { extends: "employee" },
      "research-bot": { extends: "employee" },
    });

    assignAgentsToDomain("rentright", ["compliance-bot", "research-bot"]);

    expect(getAgentDomain("compliance-bot")).toBe("rentright");
    expect(getGlobalAgent("compliance-bot")?.extends).toBe("employee");
  });

  it("allows an agent to be assigned to multiple domains", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getAgentDomains } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "shared-bot": { extends: "employee" },
    });

    assignAgentsToDomain("project-a", ["shared-bot"]);
    assignAgentsToDomain("project-b", ["shared-bot"]);

    const domains = getAgentDomains("shared-bot");
    expect(domains).toContain("project-a");
    expect(domains).toContain("project-b");
    expect(domains).toHaveLength(2);
  });

  it("getDomainAgents returns all agents assigned to a domain", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getDomainAgents } = await import("../../src/config/registry.js");

    registerGlobalAgents({
      "bot-a": { extends: "employee" },
      "bot-b": { extends: "manager" },
    });
    assignAgentsToDomain("myproject", ["bot-a", "bot-b"]);

    const agents = getDomainAgents("myproject");
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.id)).toContain("bot-a");
    expect(agents.map(a => a.id)).toContain("bot-b");
    expect(agents.find(a => a.id === "bot-b")?.config.extends).toBe("manager");
  });

  it("returns null for unregistered agent", async () => {
    const { getGlobalAgent, getAgentDomain } = await import("../../src/config/registry.js");
    expect(getGlobalAgent("nonexistent")).toBeNull();
    expect(getAgentDomain("nonexistent")).toBeNull();
  });

  it("getGlobalAgentIds returns all registered agent IDs", async () => {
    const { registerGlobalAgents, getGlobalAgentIds } = await import("../../src/config/registry.js");
    registerGlobalAgents({
      "a": { extends: "employee" },
      "b": { extends: "manager" },
    });
    const ids = getGlobalAgentIds();
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toHaveLength(2);
  });

  it("clearRegistry resets all state", async () => {
    const { registerGlobalAgents, assignAgentsToDomain, getGlobalAgent, getDomainAgents, clearRegistry } = await import("../../src/config/registry.js");

    registerGlobalAgents({ "bot": { extends: "employee" } });
    assignAgentsToDomain("domain", ["bot"]);
    clearRegistry();

    expect(getGlobalAgent("bot")).toBeNull();
    expect(getDomainAgents("domain")).toHaveLength(0);
  });

  it("public entry point favors replacement-style registry helpers", async () => {
    const core = await import("../../src/internal.js");
    expect(typeof core.syncGlobalAgents).toBe("function");
    expect(typeof core.setAgentsForDomain).toBe("function");
    expect(typeof core.removeDomain).toBe("function");
    expect("registerGlobalAgents" in core).toBe(false);
    expect("assignAgentsToDomain" in core).toBe(false);
  });
});
