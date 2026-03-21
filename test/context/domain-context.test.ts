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
});
