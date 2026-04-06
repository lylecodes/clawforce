import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDashboardExtensions,
  getDashboardExtension,
  listDashboardExtensions,
  registerDashboardExtension,
  unregisterDashboardExtension,
} from "../../src/dashboard/extensions.js";

describe("dashboard extension registry", () => {
  beforeEach(() => {
    clearDashboardExtensions();
  });

  it("registers and lists dashboard extensions", () => {
    registerDashboardExtension({
      id: "clawforce-experiments",
      title: "Experiments",
      source: { kind: "openclaw-plugin", pluginId: "@clawforce/plugin-experiments" },
      pages: [{ id: "experiments", title: "Experiments", route: "/experiments" }],
    });

    expect(listDashboardExtensions()).toHaveLength(1);
    expect(getDashboardExtension("clawforce-experiments")).toMatchObject({
      id: "clawforce-experiments",
      title: "Experiments",
    });
  });

  it("returns an unregister function", () => {
    const unregister = registerDashboardExtension({
      id: "clawforce-ops",
      title: "Ops",
      actions: [{ id: "runbook", label: "Open Runbook", surface: "overview", route: "/ops/runbook" }],
    });

    expect(unregister()).toBe(true);
    expect(unregisterDashboardExtension("clawforce-ops")).toBe(false);
  });

  it("rejects malformed contributions", () => {
    expect(() =>
      registerDashboardExtension({
        id: "bad-ext",
        title: "Bad",
        pages: [{ id: "oops", title: "Oops", route: "experiments" }],
      }),
    ).toThrow('pages.oops.route must start with "/"');
  });
});
