import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadWorkforceConfig,
  registerWorkforceConfig,
  resetEnforcementConfigForTest,
} from "../../src/project.js";
import { validateWorkforceConfig } from "../../src/config-validator.js";

describe("channels config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-channels-config-"));
    resetEnforcementConfigForTest();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetEnforcementConfigForTest();
  });

  function writeYaml(content: string): string {
    const p = path.join(tmpDir, "project.yaml");
    fs.writeFileSync(p, content, "utf-8");
    return p;
  }

  it("parses channels from project config", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager
  worker1:
    extends: employee

channels:
  - name: engineering
    type: topic
    members: [mgr, worker1]
  - name: standup
    type: meeting
    roles: [employee]
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    expect(config!.channels).toBeDefined();
    expect(config!.channels).toHaveLength(2);
    expect(config!.channels![0]!.name).toBe("engineering");
    expect(config!.channels![0]!.type).toBe("topic");
    expect(config!.channels![1]!.name).toBe("standup");
    expect(config!.channels![1]!.type).toBe("meeting");
  });

  it("silently drops channels without names during normalization", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager

channels:
  - type: topic
  - name: valid-channel
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    // Nameless entry is dropped during normalization — only valid-channel remains
    expect(config!.channels).toHaveLength(1);
    expect(config!.channels![0]!.name).toBe("valid-channel");
  });

  it("validates duplicate channel names", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager

channels:
  - name: engineering
  - name: engineering
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    const warnings = validateWorkforceConfig(config!);
    const dupeErrors = warnings.filter(w => w.message.toLowerCase().includes("duplicate"));
    expect(dupeErrors.length).toBeGreaterThan(0);
  });

  it("ignores invalid channel type during normalization (defaults to unset)", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager

channels:
  - name: bad-type
    type: invalid
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    // Invalid type is silently ignored — channel exists but type is not set
    expect(config!.channels).toHaveLength(1);
    expect(config!.channels![0]!.name).toBe("bad-type");
    expect(config!.channels![0]!.type).toBeUndefined();
  });

  it("warns on unknown member agent ID", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager

channels:
  - name: test-ch
    members: [mgr, nonexistent_agent]
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    const warnings = validateWorkforceConfig(config!);
    const memberWarns = warnings.filter(w => w.message.toLowerCase().includes("nonexistent_agent"));
    expect(memberWarns.length).toBeGreaterThan(0);
  });

  it("accepts valid channel config with telegram", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager
  worker1:
    extends: employee

channels:
  - name: engineering
    type: topic
    members: [mgr, worker1]
    telegram_group_id: "-1001234567890"
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    expect(config!.channels).toHaveLength(1);
    expect(config!.channels![0]!.telegramGroupId).toBe("-1001234567890");

    const warnings = validateWorkforceConfig(config!);
    const errors = warnings.filter(w => w.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("accepts config with no channels section", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    // channels should be undefined or empty
    const warnings = validateWorkforceConfig(config!);
    const channelErrors = warnings.filter(w => w.message.toLowerCase().includes("channel") && w.level === "error");
    expect(channelErrors).toHaveLength(0);
  });

  it("parses channel with department/team/role filters", () => {
    const configPath = writeYaml(`
name: test-project

agents:
  mgr:
    extends: manager
  worker1:
    extends: employee

channels:
  - name: eng-channel
    departments: [engineering]
    teams: [backend]
    roles: [employee]
`);

    const config = loadWorkforceConfig(configPath);
    expect(config).toBeDefined();
    expect(config!.channels![0]!.departments).toEqual(["engineering"]);
    expect(config!.channels![0]!.teams).toEqual(["backend"]);
    expect(config!.channels![0]!.presets).toEqual(["employee"]);
  });
});
