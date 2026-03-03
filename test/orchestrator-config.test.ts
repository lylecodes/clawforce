import { beforeEach, describe, expect, it } from "vitest";
import {
  registerManagerProject,
  getManagerForAgent,
  isManagerSession,
  unregisterManagerProject,
  resetManagerConfigForTest,
} from "../src/manager-config.js";
import type { ManagerSettings } from "../src/manager-config.js";

function makeSettings(overrides?: Partial<ManagerSettings>): ManagerSettings {
  return {
    enabled: true,
    agentId: "leon",
    directives: ["Run sweeps"],
    ...overrides,
  };
}

describe("manager-config", () => {
  beforeEach(() => {
    resetManagerConfigForTest();
  });

  it("registers and retrieves a manager", () => {
    registerManagerProject("proj1", makeSettings({ agentId: "leon" }));
    const entry = getManagerForAgent("leon");
    expect(entry).not.toBeNull();
    expect(entry!.projectId).toBe("proj1");
    expect(entry!.settings.agentId).toBe("leon");
  });

  it("ignores disabled settings", () => {
    registerManagerProject("proj1", makeSettings({ enabled: false, agentId: "disabled-agent" }));
    expect(getManagerForAgent("disabled-agent")).toBeNull();
  });

  it("isManagerSession returns true for registered agents", () => {
    registerManagerProject("proj1", makeSettings({ agentId: "leon" }));
    expect(isManagerSession("leon")).toBe(true);
  });

  it("isManagerSession returns false for unregistered agents", () => {
    expect(isManagerSession("unknown")).toBe(false);
  });

  it("isManagerSession returns false for undefined", () => {
    expect(isManagerSession(undefined)).toBe(false);
  });

  it("unregisters a manager", () => {
    registerManagerProject("proj1", makeSettings({ agentId: "leon" }));
    unregisterManagerProject("leon");
    expect(getManagerForAgent("leon")).toBeNull();
    expect(isManagerSession("leon")).toBe(false);
  });

  it("resetManagerConfigForTest clears all", () => {
    registerManagerProject("proj1", makeSettings({ agentId: "leon" }));
    registerManagerProject("proj2", makeSettings({ agentId: "otto" }));
    resetManagerConfigForTest();
    expect(getManagerForAgent("leon")).toBeNull();
    expect(getManagerForAgent("otto")).toBeNull();
  });
});
