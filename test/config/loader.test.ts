import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("global config loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-loader-"));
    fs.mkdirSync(path.join(tmpDir, "domains"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads global config and domain configs", async () => {
    const { loadGlobalConfig, loadAllDomains } = await import(
      "../../src/config/loader.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      [
        "agents:",
        "  my-agent:",
        "    extends: employee",
        "defaults:",
        "  model: anthropic/claude-opus-4-6",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "rentright.yaml"),
      [
        "domain: rentright",
        "agents:",
        "  - my-agent",
        "paths:",
        "  - ~/workplace/rentright",
      ].join("\n"),
    );

    const global = loadGlobalConfig(tmpDir);
    expect(global.agents["my-agent"].extends).toBe("employee");

    const domains = loadAllDomains(tmpDir);
    expect(domains).toHaveLength(1);
    expect(domains[0].domain).toBe("rentright");
    expect(domains[0].agents).toContain("my-agent");
  });

  it("returns empty agents if no config.yaml exists", async () => {
    const { loadGlobalConfig } = await import("../../src/config/loader.js");
    const global = loadGlobalConfig(tmpDir);
    expect(global.agents).toEqual({});
  });

  it("returns empty array if no domain files exist", async () => {
    const { loadAllDomains } = await import("../../src/config/loader.js");
    // Remove the domains dir
    fs.rmSync(path.join(tmpDir, "domains"), { recursive: true });
    const domains = loadAllDomains(tmpDir);
    expect(domains).toHaveLength(0);
  });

  it("resolves domain from working directory", async () => {
    const { loadAllDomains, resolveDomainFromPath } = await import(
      "../../src/config/loader.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "domains", "myapp.yaml"),
      [
        "domain: myapp",
        "agents:",
        "  - a",
        "paths:",
        "  - /home/user/code/myapp",
        "  - /home/user/code/myapp-api",
      ].join("\n"),
    );

    const domains = loadAllDomains(tmpDir);
    const match = resolveDomainFromPath(
      "/home/user/code/myapp-api/src/index.ts",
      domains,
    );
    expect(match).toBe("myapp");
  });

  it("returns null for unmatched working directory", async () => {
    const { loadAllDomains, resolveDomainFromPath } = await import(
      "../../src/config/loader.js"
    );

    fs.writeFileSync(
      path.join(tmpDir, "domains", "myapp.yaml"),
      [
        "domain: myapp",
        "agents:",
        "  - a",
        "paths:",
        "  - /home/user/code/myapp",
      ].join("\n"),
    );

    const domains = loadAllDomains(tmpDir);
    const match = resolveDomainFromPath(
      "/home/user/other-project/file.ts",
      domains,
    );
    expect(match).toBeNull();
  });

  it("validates agents in domain are defined globally", async () => {
    const { loadGlobalConfig, loadAllDomains, validateDomainAgents } =
      await import("../../src/config/loader.js");

    fs.writeFileSync(
      path.join(tmpDir, "config.yaml"),
      ["agents:", "  agent-a:", "    extends: employee"].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "domains", "test.yaml"),
      ["domain: test", "agents:", "  - agent-a", "  - agent-b"].join("\n"),
    );

    const global = loadGlobalConfig(tmpDir);
    const domains = loadAllDomains(tmpDir);
    const warnings = validateDomainAgents(global, domains[0]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("agent-b");
  });
});
