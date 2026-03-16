import { describe, it, expect } from "vitest";
import { Clawforce } from "../../src/sdk/index.js";

describe("Clawforce SDK", () => {
  it("initializes with domain", () => {
    const cf = Clawforce.init({ domain: "test-domain" });
    expect(cf.domain).toBe("test-domain");
  });

  it("exposes all namespace accessors", () => {
    const cf = Clawforce.init({ domain: "test-domain" });
    expect(cf.tasks).toBeDefined();
    expect(cf.events).toBeDefined();
    expect(cf.budget).toBeDefined();
    expect(cf.agents).toBeDefined();
    expect(cf.trust).toBeDefined();
    expect(cf.goals).toBeDefined();
    expect(cf.messages).toBeDefined();
    expect(cf.monitoring).toBeDefined();
  });

  it("returns same namespace instance on repeated access", () => {
    const cf = Clawforce.init({ domain: "test-domain" });
    expect(cf.tasks).toBe(cf.tasks);
    expect(cf.events).toBe(cf.events);
  });

  it("passes domain to namespaces", () => {
    const cf = Clawforce.init({ domain: "my-project" });
    expect(cf.tasks.domain).toBe("my-project");
    expect(cf.events.domain).toBe("my-project");
  });
});
