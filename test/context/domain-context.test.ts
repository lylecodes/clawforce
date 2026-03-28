import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("renderDomainContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-domain-ctx-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupContextFile(domain: string, fileName: string, content: string): void {
    const contextDir = path.join(tmpDir, "domains", domain, "context");
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, fileName), content);
  }

  it("reads DIRECTION.md for 'direction' source type", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "DIRECTION.md", "# Project Direction\n\nBuild the best product.");

    const result = renderDomainContext(tmpDir, "myproject", "direction");
    expect(result).toBe("# Project Direction\n\nBuild the best product.");
  });

  it("reads POLICIES.md for 'policies' source type", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "POLICIES.md", "All code must have tests.");

    const result = renderDomainContext(tmpDir, "myproject", "policies");
    expect(result).toBe("All code must have tests.");
  });

  it("reads STANDARDS.md for 'standards' source type", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "STANDARDS.md", "Use TypeScript strict mode.");

    const result = renderDomainContext(tmpDir, "myproject", "standards");
    expect(result).toBe("Use TypeScript strict mode.");
  });

  it("reads ARCHITECTURE.md for 'architecture' source type", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "ARCHITECTURE.md", "Monorepo with shared packages.");

    const result = renderDomainContext(tmpDir, "myproject", "architecture");
    expect(result).toBe("Monorepo with shared packages.");
  });

  it("returns null when file does not exist", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");

    const result = renderDomainContext(tmpDir, "myproject", "direction");
    expect(result).toBeNull();
  });

  it("returns null for empty file", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "DIRECTION.md", "   \n  \n  ");

    const result = renderDomainContext(tmpDir, "myproject", "direction");
    expect(result).toBeNull();
  });

  it("returns null for unknown source type", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");

    const result = renderDomainContext(tmpDir, "myproject", "unknown_source");
    expect(result).toBeNull();
  });

  it("trims whitespace from file content", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "POLICIES.md", "\n\n  All code reviewed.  \n\n");

    const result = renderDomainContext(tmpDir, "myproject", "policies");
    expect(result).toBe("All code reviewed.");
  });

  // --- Per-team DIRECTION.md support ---

  it("returns team-specific direction when DIRECTION-{team}.md exists", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "DIRECTION.md", "Domain-wide direction.");
    setupContextFile("myproject", "DIRECTION-core.md", "Core team direction.");

    const result = renderDomainContext(tmpDir, "myproject", "direction", "core");
    expect(result).toBe("Core team direction.");
  });

  it("falls back to domain direction when team-specific file does not exist", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "DIRECTION.md", "Domain-wide direction.");

    const result = renderDomainContext(tmpDir, "myproject", "direction", "dashboard");
    expect(result).toBe("Domain-wide direction.");
  });

  it("returns domain direction when no team is specified", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "DIRECTION.md", "Domain-wide direction.");
    setupContextFile("myproject", "DIRECTION-core.md", "Core team direction.");

    const result = renderDomainContext(tmpDir, "myproject", "direction");
    expect(result).toBe("Domain-wide direction.");
  });

  it("returns domain direction when team is undefined", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "DIRECTION.md", "Domain-wide direction.");
    setupContextFile("myproject", "DIRECTION-core.md", "Core team direction.");

    const result = renderDomainContext(tmpDir, "myproject", "direction", undefined);
    expect(result).toBe("Domain-wide direction.");
  });

  it("returns null when team file missing and no domain fallback", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    // No files at all

    const result = renderDomainContext(tmpDir, "myproject", "direction", "core");
    expect(result).toBeNull();
  });

  // --- Per-team STANDARDS.md support ---

  it("returns team-specific standards when STANDARDS-{team}.md exists", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "STANDARDS.md", "Domain-wide standards.");
    setupContextFile("myproject", "STANDARDS-dashboard.md", "Dashboard team standards.");

    const result = renderDomainContext(tmpDir, "myproject", "standards", "dashboard");
    expect(result).toBe("Dashboard team standards.");
  });

  it("falls back to domain standards when team-specific standards file does not exist", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "STANDARDS.md", "Domain-wide standards.");

    const result = renderDomainContext(tmpDir, "myproject", "standards", "nonexistent");
    expect(result).toBe("Domain-wide standards.");
  });

  it("returns domain standards when no team is specified", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "STANDARDS.md", "Domain-wide standards.");
    setupContextFile("myproject", "STANDARDS-dashboard.md", "Dashboard team standards.");

    const result = renderDomainContext(tmpDir, "myproject", "standards");
    expect(result).toBe("Domain-wide standards.");
  });

  // --- Per-team POLICIES.md support ---

  it("returns team-specific policies when POLICIES-{team}.md exists", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "POLICIES.md", "Domain-wide policies.");
    setupContextFile("myproject", "POLICIES-core.md", "Core team policies.");

    const result = renderDomainContext(tmpDir, "myproject", "policies", "core");
    expect(result).toBe("Core team policies.");
  });

  it("falls back to domain policies when team-specific policies file does not exist", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "POLICIES.md", "Domain-wide policies.");

    const result = renderDomainContext(tmpDir, "myproject", "policies", "nonexistent");
    expect(result).toBe("Domain-wide policies.");
  });

  // --- Per-team ARCHITECTURE.md support ---

  it("returns team-specific architecture when ARCHITECTURE-{team}.md exists", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "ARCHITECTURE.md", "Domain-wide architecture.");
    setupContextFile("myproject", "ARCHITECTURE-infra.md", "Infra team architecture.");

    const result = renderDomainContext(tmpDir, "myproject", "architecture", "infra");
    expect(result).toBe("Infra team architecture.");
  });

  it("falls back to domain architecture when team-specific architecture file does not exist", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    setupContextFile("myproject", "ARCHITECTURE.md", "Domain-wide architecture.");

    const result = renderDomainContext(tmpDir, "myproject", "architecture", "nonexistent");
    expect(result).toBe("Domain-wide architecture.");
  });

  it("returns null when team file missing and no domain fallback for any source type", async () => {
    const { renderDomainContext } = await import("../../src/context/domain-context.js");
    // No files at all

    expect(renderDomainContext(tmpDir, "myproject", "standards", "core")).toBeNull();
    expect(renderDomainContext(tmpDir, "myproject", "policies", "core")).toBeNull();
    expect(renderDomainContext(tmpDir, "myproject", "architecture", "core")).toBeNull();
  });
});
