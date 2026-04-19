import { beforeEach, describe, expect, it, vi } from "vitest";

let assistantConfig: Record<string, unknown> | null = null;
let agentEntries = new Map<string, Record<string, unknown>>();

vi.mock("../../../src/config/api-service.js", () => ({
  readDomainConfig: vi.fn(() => assistantConfig),
}));

vi.mock("../../../src/project.js", () => ({
  getRegisteredAgentIds: vi.fn(() => Array.from(agentEntries.keys())),
  getAgentConfig: vi.fn((agentId: string) => agentEntries.get(agentId) ?? null),
}));

const {
  getDashboardAssistantSettings,
  parseAssistantDirective,
  queryDashboardAssistantStatus,
  renderAssistantStoredMessage,
  renderAssistantUnavailableMessage,
  resolveAssistantFallbackTarget,
} = await import("../../../src/app/queries/dashboard-assistant.js");

describe("dashboard assistant query helpers", () => {
  beforeEach(() => {
    assistantConfig = null;
    agentEntries = new Map([
      ["lead-root", {
        projectId: "test-project",
        config: { title: "Root Lead", coordination: { enabled: true } },
      }],
      ["lead-child", {
        projectId: "test-project",
        config: { title: "Child Lead", coordination: { enabled: true }, reports_to: "lead-root" },
      }],
      ["worker-1", {
        projectId: "test-project",
        config: { title: "Worker", reports_to: "lead-root" },
      }],
    ]);
  });

  it("defaults the dashboard assistant to enabled", () => {
    expect(getDashboardAssistantSettings("test-project")).toEqual({ enabled: true });
  });

  it("parses explicit @mentions and prefers configured assistant targets", () => {
    assistantConfig = { dashboard_assistant: { agentId: "lead-child" } };

    expect(parseAssistantDirective("@lead-root please check this")).toEqual({
      requestedAgentId: "lead-root",
      content: "please check this",
    });
    expect(resolveAssistantFallbackTarget("test-project", undefined)).toEqual({
      agentId: "lead-child",
      title: "Child Lead",
      explicit: false,
      source: "configured",
    });
  });

  it("falls back to the root lead and renders the stored copy", () => {
    const target = resolveAssistantFallbackTarget("test-project");
    expect(target).toEqual({
      agentId: "lead-root",
      title: "Root Lead",
      explicit: false,
      source: "lead",
    });
    expect(renderAssistantStoredMessage(target!)).toContain("\"lead-root\"");
    expect(queryDashboardAssistantStatus("test-project")).toEqual({
      enabled: true,
      configuredAgentId: undefined,
      resolvedAgentId: "lead-root",
      resolvedTitle: "Root Lead",
      resolutionSource: "lead",
      deliveryPolicy: "live-if-session-available-else-store",
      directMentionsSupported: true,
      note: 'Operator chat routes to lead "lead-root" by default and falls back to stored delivery when no live session is available.',
    });
  });

  it("reports disabled assistant state when no fallback target should be used", () => {
    assistantConfig = { dashboard_assistant: { enabled: false } };

    expect(resolveAssistantFallbackTarget("test-project")).toBeNull();
    expect(renderAssistantUnavailableMessage("test-project")).toContain("dashboard assistant is disabled");
    expect(queryDashboardAssistantStatus("test-project")).toEqual({
      enabled: false,
      configuredAgentId: undefined,
      resolvedAgentId: undefined,
      resolvedTitle: undefined,
      resolutionSource: undefined,
      deliveryPolicy: "unavailable",
      directMentionsSupported: true,
      note: "The dashboard assistant is disabled for this domain. Use @lead-id in chat to message a lead directly, or enable dashboard_assistant in domain config.",
    });
  });
});
