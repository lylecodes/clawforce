import { describe, expect, it, beforeEach } from "vitest";
import {
  registerManagerProject,
  getManagerForAgent,
  isManagerSession,
  unregisterManagerProject,
  resetManagerConfigForTest,
} from "../src/manager-config.js";
import type { ManagerSettings } from "../src/manager-config.js";

const settings: ManagerSettings = {
  enabled: true,
  agentId: "mgr-1",
  cronSchedule: "5m",
  directives: ["review tasks"],
};

describe("manager-config", () => {
  beforeEach(() => {
    resetManagerConfigForTest();
  });

  it("registers and retrieves a manager project", () => {
    registerManagerProject("proj1", settings);
    const result = getManagerForAgent("mgr-1");
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("proj1");
    expect(result!.settings.agentId).toBe("mgr-1");
  });

  it("skips registration when enabled is false", () => {
    registerManagerProject("proj1", { ...settings, enabled: false });
    expect(getManagerForAgent("mgr-1")).toBeNull();
  });

  it("isManagerSession returns true for registered agent", () => {
    registerManagerProject("proj1", settings);
    expect(isManagerSession("mgr-1")).toBe(true);
  });

  it("isManagerSession returns false for unknown agent", () => {
    expect(isManagerSession("unknown")).toBe(false);
  });

  it("isManagerSession returns false for undefined", () => {
    expect(isManagerSession(undefined)).toBe(false);
  });

  it("unregister removes the manager", () => {
    registerManagerProject("proj1", settings);
    expect(isManagerSession("mgr-1")).toBe(true);
    unregisterManagerProject("mgr-1");
    expect(isManagerSession("mgr-1")).toBe(false);
    expect(getManagerForAgent("mgr-1")).toBeNull();
  });

  it("reset clears all registrations", () => {
    registerManagerProject("proj1", settings);
    registerManagerProject("proj2", { ...settings, agentId: "mgr-2" });
    resetManagerConfigForTest();
    expect(isManagerSession("mgr-1")).toBe(false);
    expect(isManagerSession("mgr-2")).toBe(false);
  });
});
