import { beforeEach, describe, expect, it, vi } from "vitest";

let projectIds: string[] = [];
let extensions: Array<{ id: string; title: string }> = [];
let extConfigByDomain = new Map<string, Record<string, unknown> | null>();
let agentEntries = new Map<string, { projectId: string }>();
let attentionByDomain = new Map<string, { counts: { actionNeeded: number; watching: number; fyi: number } }>();
let assistantSettingsByDomain = new Map<string, { enabled: boolean; agentId?: string }>();
let assistantTargetByDomain = new Map<string, { agentId: string; title?: string; source: "configured" | "lead" } | null>();

vi.mock("../../../src/lifecycle.js", () => ({
  getActiveProjectIds: vi.fn(() => projectIds),
}));

vi.mock("../../../src/dashboard/extensions.js", () => ({
  listDashboardExtensions: vi.fn(() => extensions),
}));

vi.mock("../../../src/project.js", () => ({
  getRegisteredAgentIds: vi.fn(() => Array.from(agentEntries.keys())),
  getAgentConfig: vi.fn((agentId: string) => agentEntries.get(agentId) ?? null),
  getExtendedProjectConfig: vi.fn((projectId: string) => extConfigByDomain.get(projectId) ?? null),
}));

vi.mock("../../../src/attention/builder.js", () => ({
  buildAttentionSummary: vi.fn((projectId: string) => ({
    domainId: projectId,
    counts: attentionByDomain.get(projectId)?.counts ?? { actionNeeded: 0, watching: 0, fyi: 0 },
    sections: [],
    generatedAt: 123,
  })),
  buildDecisionInboxSummary: vi.fn((projectId: string) => ({
    domainId: projectId,
    counts: attentionByDomain.get(projectId)?.counts ?? { actionNeeded: 0, watching: 0, fyi: 0 },
    sections: [],
    generatedAt: 123,
  })),
}));

vi.mock("../../../src/app/queries/dashboard-assistant.js", () => ({
  getDashboardAssistantSettings: vi.fn((projectId: string) => assistantSettingsByDomain.get(projectId) ?? { enabled: true }),
  resolveAssistantFallbackTarget: vi.fn((projectId: string) => assistantTargetByDomain.get(projectId) ?? null),
}));

const {
  queryActiveAttentionRollup,
  queryActiveDomains,
  queryDashboardExtensions,
  queryDashboardRuntimeMetadata,
  queryDomainCapabilities,
} = await import("../../../src/app/queries/dashboard-meta.js");

describe("dashboard meta app queries", () => {
  beforeEach(() => {
    projectIds = ["alpha", "beta"];
    extensions = [{ id: "clawforce-experiments", title: "Experiments" }];
    extConfigByDomain = new Map([
      ["alpha", {
        policies: { approvals: true },
        safety: { costCircuitBreaker: 2 },
        trust: { baseline: 0.8 },
        memory: { enabled: true },
        channels: [{ id: "ops" }],
      }],
      ["beta", null],
    ]);
    agentEntries = new Map([
      ["lead-a", { projectId: "alpha" }],
      ["worker-a", { projectId: "alpha" }],
      ["lead-b", { projectId: "beta" }],
    ]);
    attentionByDomain = new Map([
      ["alpha", { counts: { actionNeeded: 2, watching: 1, fyi: 0 } }],
      ["beta", { counts: { actionNeeded: 1, watching: 0, fyi: 4 } }],
    ]);
    assistantSettingsByDomain = new Map([
      ["alpha", { enabled: true }],
      ["beta", { enabled: true }],
    ]);
    assistantTargetByDomain = new Map([
      ["alpha", { agentId: "lead-a", title: "Lead A", source: "lead" }],
      ["beta", { agentId: "lead-b", title: "Lead B", source: "lead" }],
    ]);
  });

  it("lists active domains with agent counts", () => {
    expect(queryActiveDomains()).toEqual([
      { id: "alpha", agentCount: 2 },
      { id: "beta", agentCount: 1 },
    ]);
  });

  it("returns dashboard extension metadata and runtime fallback", () => {
    expect(queryDashboardExtensions()).toEqual({
      extensions: [{ id: "clawforce-experiments", title: "Experiments" }],
      count: 1,
    });
    expect(queryDashboardRuntimeMetadata()).toEqual({
      mode: "standalone",
      authMode: "localhost-only",
      notes: ["Runtime metadata was not explicitly provided by the caller."],
    });
  });

  it("aggregates attention across active domains", () => {
    expect(queryActiveAttentionRollup()).toEqual({
      businesses: [
        expect.objectContaining({ domainId: "alpha", counts: { actionNeeded: 2, watching: 1, fyi: 0 } }),
        expect.objectContaining({ domainId: "beta", counts: { actionNeeded: 1, watching: 0, fyi: 4 } }),
      ],
      totals: { actionNeeded: 3, watching: 1, fyi: 4 },
    });
  });

  it("builds domain capabilities from config and loaded extensions", () => {
    expect(queryDomainCapabilities("alpha")).toEqual(expect.objectContaining({
      version: "0.2.0",
      features: {
        tasks: true,
        approvals: true,
        budget: true,
        trust: true,
        memory: true,
        comms: true,
      },
      messaging: {
        operatorChat: true,
        directAgentMessaging: true,
        channels: true,
        assistantRouting: true,
      },
      extensions: {
        count: 1,
        ids: ["clawforce-experiments"],
      },
    }));
  });

  it("reports direct operator messaging even when channels are not configured", () => {
    expect(queryDomainCapabilities("beta")).toEqual(expect.objectContaining({
      features: expect.objectContaining({
        comms: true,
      }),
      messaging: {
        operatorChat: true,
        directAgentMessaging: true,
        channels: false,
        assistantRouting: true,
      },
    }));
  });
});
