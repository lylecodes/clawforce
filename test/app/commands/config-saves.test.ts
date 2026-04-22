import { beforeEach, describe, expect, it, vi } from "vitest";

const saveDomainConfigSectionMock = vi.fn(() => ({ ok: true }));
const previewDomainConfigSectionChangeMock = vi.fn((_projectId: string, section: string) => ({
  ok: true,
  preview: {
    before: {},
    after: {},
    valid: true,
    changedPaths: [section],
    changedKeys: [section],
  },
}));
const previewGlobalConfigSectionChangeMock = vi.fn((_section: string) => ({
  before: {},
  after: {},
  valid: true,
  changedPaths: ["agents"],
  changedKeys: ["agents"],
}));
const readDomainConfigMock = vi.fn(() => ({
  agents: ["a1"],
  budget: {
    daily: { cents: 1000, tokens: 10000, requests: 10 },
  },
  operational_profile: "medium",
  goals: {
    existing: { allocation: 25, description: "Existing goal" },
  },
  dashboard_assistant: {
    enabled: true,
    agentId: "a1",
  },
  safety: {
    costCircuitBreaker: 3,
  },
}));
const readGlobalConfigMock = vi.fn(() => ({
  agents: {
    a1: {
      title: "Ops Lead",
      persona: "Original persona",
      jobs: {
        standup: {
          cron: "0 9 * * *",
          enabled: true,
          description: "Daily sync",
        },
      },
    },
  },
}));
const reloadDomainRuntimesMock = vi.fn(() => ({ domains: ["test-project"], errors: [] }));
const updateGlobalAgentConfigMock = vi.fn(() => ({ ok: true }));
const upsertGlobalAgentsMock = vi.fn(() => ({ ok: true }));

vi.mock("../../../src/config/api-service.js", () => ({
  previewDomainConfigSectionChange: previewDomainConfigSectionChangeMock,
  previewGlobalConfigSectionChange: previewGlobalConfigSectionChangeMock,
  readDomainConfig: readDomainConfigMock,
  readGlobalConfig: readGlobalConfigMock,
  reloadDomainRuntimes: reloadDomainRuntimesMock,
  saveDomainConfigSection: saveDomainConfigSectionMock,
  updateGlobalAgentConfig: updateGlobalAgentConfigMock,
  upsertGlobalAgents: upsertGlobalAgentsMock,
}));

vi.mock("../../../src/config/init.js", () => ({
  getDomainRuntimeReloadStatus: vi.fn(() => null),
}));

vi.mock("../../../src/agent-runtime-config.js", () => ({
  mergeAgentRuntimeConfig: vi.fn((_current: unknown, next: unknown) => next),
  normalizeConfiguredAgentRuntime: vi.fn((value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "runtime" in value) {
      return (value as Record<string, unknown>).runtime;
    }
    return undefined;
  }),
}));

vi.mock("../../../src/config/registry.js", () => ({
  getAgentDomains: vi.fn(() => []),
}));

vi.mock("../../../src/project.js", () => ({
  getRegisteredAgentIds: vi.fn(() => ["a1"]),
  getAgentConfig: vi.fn((agentId: string) => (
    agentId === "a1" ? { projectId: "test-project", config: {} } : null
  )),
}));

vi.mock("../../../src/diagnostics.js", () => ({
  safeLog: vi.fn(),
}));

const {
  previewSaveConfigCommand,
  runSaveConfigCommand,
} = await import("../../../src/app/commands/config-saves.js");

describe("config save command logical semantics", () => {
  beforeEach(() => {
    previewDomainConfigSectionChangeMock.mockClear();
    previewGlobalConfigSectionChangeMock.mockClear();
    saveDomainConfigSectionMock.mockClear();
    readDomainConfigMock.mockClear();
    readGlobalConfigMock.mockClear();
    reloadDomainRuntimesMock.mockClear();
    updateGlobalAgentConfigMock.mockClear();
    upsertGlobalAgentsMock.mockClear();
  });

  it("records logical before/after state for budget saves", () => {
    const result = runSaveConfigCommand("test-project", {
      section: "budget",
      data: {
        daily: { cents: 2000, tokens: 50000, requests: 25 },
        operational_profile: "high",
        initiatives: {
          existing: 55,
        },
      },
      actor: "user",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.change).toEqual({
      resourceId: "budget",
      before: {
        daily: { cents: 1000, tokens: 10000, requests: 10 },
        operational_profile: "medium",
        initiatives: { existing: 25 },
      },
      after: {
        daily: { cents: 2000, tokens: 50000, requests: 25 },
        operational_profile: "high",
        initiatives: { existing: 55 },
      },
      reversible: true,
    });
  });

  it("records logical object state for profile alias saves", () => {
    const result = runSaveConfigCommand("test-project", {
      section: "profile",
      data: { operational_profile: "high" },
      actor: "user",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.change?.before).toEqual({ operational_profile: "medium" });
    expect(result.change?.after).toEqual({ operational_profile: "high" });
  });

  it("records logical initiatives state instead of raw goals snapshots", () => {
    const result = runSaveConfigCommand("test-project", {
      section: "initiatives",
      data: {
        existing: { allocation_pct: 40, goal: "existing" },
      },
      actor: "user",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.change?.before).toEqual({
      existing: { allocation_pct: 25, goal: "existing" },
    });
    expect(result.change?.after).toEqual({
      existing: { allocation_pct: 40, goal: "existing" },
    });
  });

  it("uses logical section keys for budget preview even when save splits across persisted sections", () => {
    const result = previewSaveConfigCommand("test-project", {
      section: "budget",
      data: {
        daily: { cents: 2000 },
        operational_profile: "high",
        initiatives: { existing: 55 },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.changedKeys).toEqual(["daily", "operational_profile", "initiatives"]);
    expect(previewDomainConfigSectionChangeMock).toHaveBeenCalledWith(
      "test-project",
      "budget",
      { daily: { cents: 2000 } },
    );
    expect(previewDomainConfigSectionChangeMock).toHaveBeenCalledWith(
      "test-project",
      "operational_profile",
      "high",
    );
    expect(previewDomainConfigSectionChangeMock).toHaveBeenCalledWith(
      "test-project",
      "goals",
      {
        existing: { allocation: 55, description: "Existing goal" },
      },
    );
  });

  it("uses logical agent ids for agents preview and change tracking", () => {
    const preview = previewSaveConfigCommand("test-project", {
      section: "agents",
      data: [
        {
          id: "a1",
          title: "Updated Lead",
        },
      ],
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.changedKeys).toEqual(["a1"]);

    const save = runSaveConfigCommand("test-project", {
      section: "agents",
      data: [
        {
          id: "a1",
          title: "Updated Lead",
        },
      ],
      actor: "user",
    });

    expect(save.ok).toBe(true);
    if (!save.ok) return;

    expect(save.change?.before).toEqual([
      expect.objectContaining({
        id: "a1",
        title: "Ops Lead",
        persona: "Original persona",
      }),
    ]);
    expect(save.change?.after).toEqual([
      expect.objectContaining({
        id: "a1",
        title: "Updated Lead",
      }),
    ]);
  });

  it("uses logical job ids for jobs preview and change tracking", () => {
    const preview = previewSaveConfigCommand("test-project", {
      section: "jobs",
      data: [
        {
          id: "a1:standup",
          agent: "a1",
          cron: "0 10 * * *",
          enabled: false,
          description: "Updated sync",
        },
      ],
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.changedKeys).toEqual(["a1:standup"]);

    const save = runSaveConfigCommand("test-project", {
      section: "jobs",
      data: [
        {
          id: "a1:standup",
          agent: "a1",
          cron: "0 10 * * *",
          enabled: false,
          description: "Updated sync",
        },
      ],
      actor: "user",
    });

    expect(save.ok).toBe(true);
    if (!save.ok) return;

    expect(save.change?.before).toEqual([
      {
        id: "a1:standup",
        agent: "a1",
        cron: "0 9 * * *",
        enabled: true,
        description: "Daily sync",
      },
    ]);
    expect(save.change?.after).toEqual([
      {
        id: "a1:standup",
        agent: "a1",
        cron: "0 10 * * *",
        enabled: false,
        description: "Updated sync",
      },
    ]);
  });
});
