import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("skill topics reflect domain architecture", () => {
  it("config topic mentions domains", async () => {
    const { generate } = await import("../../src/skills/topics/config.js");
    const content = generate();
    expect(content).toContain("domain");
  });

  it("config topic documents rule system", async () => {
    const { generate } = await import("../../src/skills/topics/config.js");
    const content = generate();
    expect(content).toContain("rule");
    expect(content).toContain("trigger");
    expect(content).toContain("prompt_template");
  });

  it("roles topic references domains", async () => {
    const { generate } = await import("../../src/skills/topics/roles.js");
    const content = generate();
    // Should contain "domain" somewhere in the documentation
    expect(content.toLowerCase()).toContain("domain");
  });

  it("tools topic documents setup capabilities", async () => {
    const { generate } = await import("../../src/skills/topics/tools.js");
    const content = generate();
    expect(content.toLowerCase()).toContain("setup");
  });
});
