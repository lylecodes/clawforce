/**
 * Router-level tests for the Phase A workspace resources.
 *
 * Only the new workspace query functions are mocked — everything else in the
 * dashboard-read-router module graph loads normally. We never reach those
 * other cases because every test drives a `workspace/*` or `workflows/*`
 * resource path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryProjectWorkspaceMock = vi.fn();
const queryWorkflowDraftSessionMock = vi.fn();
const queryWorkflowDraftSessionsMock = vi.fn();
const queryWorkflowTopologyMock = vi.fn();
const queryWorkflowStageInspectorMock = vi.fn();
const queryScopedWorkspaceFeedMock = vi.fn();

vi.mock("../../../src/workspace/queries.js", () => ({
  queryProjectWorkspace: queryProjectWorkspaceMock,
  queryWorkflowDraftSession: queryWorkflowDraftSessionMock,
  queryWorkflowDraftSessions: queryWorkflowDraftSessionsMock,
  queryWorkflowTopology: queryWorkflowTopologyMock,
  queryWorkflowStageInspector: queryWorkflowStageInspectorMock,
  queryScopedWorkspaceFeed: queryScopedWorkspaceFeedMock,
}));

const { routeGatewayDomainRead } = await import("../../../src/app/queries/dashboard-read-router.js");

const DOMAIN = "ws-test";

beforeEach(() => {
  queryProjectWorkspaceMock.mockReset();
  queryWorkflowDraftSessionMock.mockReset();
  queryWorkflowDraftSessionsMock.mockReset();
  queryWorkflowTopologyMock.mockReset();
  queryWorkflowStageInspectorMock.mockReset();
  queryScopedWorkspaceFeedMock.mockReset();
});

describe("routeGatewayDomainRead — workspace resource", () => {
  it("routes GET /workspace to queryProjectWorkspace", () => {
    const payload = { scope: { kind: "project", domainId: DOMAIN }, domainId: DOMAIN, operator: {}, workflows: [], draftSessions: [] };
    queryProjectWorkspaceMock.mockReturnValue(payload);

    const result = routeGatewayDomainRead(DOMAIN, "workspace", {});
    expect(result.status).toBe(200);
    expect(result.body).toBe(payload);
    expect(queryProjectWorkspaceMock).toHaveBeenCalledWith(DOMAIN);
  });

  it("routes GET /workspace/overview to queryProjectWorkspace as an alias", () => {
    const payload = { scope: { kind: "project", domainId: DOMAIN }, workflows: [] };
    queryProjectWorkspaceMock.mockReturnValue(payload);
    const result = routeGatewayDomainRead(DOMAIN, "workspace/overview", {});
    expect(result.status).toBe(200);
    expect(result.body).toBe(payload);
  });

  it("404s an unknown workspace sub-resource", () => {
    const result = routeGatewayDomainRead(DOMAIN, "workspace/bogus", {});
    expect(result.status).toBe(404);
    expect(queryProjectWorkspaceMock).not.toHaveBeenCalled();
  });
});

describe("routeGatewayDomainRead — workspace/feed", () => {
  it("defaults to project scope with no params", () => {
    queryScopedWorkspaceFeedMock.mockReturnValue({ scope: { kind: "project", domainId: DOMAIN } });
    const result = routeGatewayDomainRead(DOMAIN, "workspace/feed", {});
    expect(result.status).toBe(200);
    expect(queryScopedWorkspaceFeedMock).toHaveBeenCalledWith({ kind: "project", domainId: DOMAIN });
  });

  it("infers workflow scope when workflowId is given without an explicit scope param", () => {
    queryScopedWorkspaceFeedMock.mockReturnValue({ scope: { kind: "workflow", domainId: DOMAIN, workflowId: "wf-1" } });
    const result = routeGatewayDomainRead(DOMAIN, "workspace/feed", { workflowId: "wf-1" });
    expect(result.status).toBe(200);
    expect(queryScopedWorkspaceFeedMock).toHaveBeenCalledWith({
      kind: "workflow",
      domainId: DOMAIN,
      workflowId: "wf-1",
    });
  });

  it("routes explicit stage scope when workflowId and stageKey are both given", () => {
    queryScopedWorkspaceFeedMock.mockReturnValue({ scope: { kind: "stage", domainId: DOMAIN, workflowId: "wf-1", stageKey: "wf-1:phase:0" } });
    const result = routeGatewayDomainRead(DOMAIN, "workspace/feed", {
      scope: "stage",
      workflowId: "wf-1",
      stageKey: "wf-1:phase:0",
    });
    expect(result.status).toBe(200);
    expect(queryScopedWorkspaceFeedMock).toHaveBeenCalledWith({
      kind: "stage",
      domainId: DOMAIN,
      workflowId: "wf-1",
      stageKey: "wf-1:phase:0",
    });
  });

  it("returns 400 when stage scope is requested without the required inputs", () => {
    const result = routeGatewayDomainRead(DOMAIN, "workspace/feed", { scope: "stage", workflowId: "wf-1" });
    expect(result.status).toBe(400);
    expect(queryScopedWorkspaceFeedMock).not.toHaveBeenCalled();
  });

  it("returns 400 when workflow scope is requested without a workflowId", () => {
    const result = routeGatewayDomainRead(DOMAIN, "workspace/feed", { scope: "workflow" });
    expect(result.status).toBe(400);
    expect(queryScopedWorkspaceFeedMock).not.toHaveBeenCalled();
  });
});

describe("routeGatewayDomainRead — workspace/drafts", () => {
  it("routes GET /workspace/drafts to queryWorkflowDraftSessions", () => {
    const payload = [{ scope: { kind: "draft", domainId: DOMAIN, workflowId: "wf-1", draftSessionId: "ds-1" } }];
    queryWorkflowDraftSessionsMock.mockReturnValue(payload);

    const result = routeGatewayDomainRead(DOMAIN, "workspace/drafts", {});
    expect(result.status).toBe(200);
    expect(result.body).toBe(payload);
    expect(queryWorkflowDraftSessionsMock).toHaveBeenCalledWith(DOMAIN, undefined);
  });

  it("passes through workflowId filtering for draft inventory", () => {
    queryWorkflowDraftSessionsMock.mockReturnValue([]);
    const result = routeGatewayDomainRead(DOMAIN, "workspace/drafts", { workflowId: "wf-1" });
    expect(result.status).toBe(200);
    expect(queryWorkflowDraftSessionsMock).toHaveBeenCalledWith(DOMAIN, "wf-1");
  });

  it("routes GET /workspace/drafts/:id to queryWorkflowDraftSession", () => {
    const payload = { scope: { kind: "draft", domainId: DOMAIN, workflowId: "wf-1", draftSessionId: "ds-1" } };
    queryWorkflowDraftSessionMock.mockReturnValue(payload);

    const result = routeGatewayDomainRead(DOMAIN, "workspace/drafts/ds-1", {});
    expect(result.status).toBe(200);
    expect(result.body).toBe(payload);
    expect(queryWorkflowDraftSessionMock).toHaveBeenCalledWith(DOMAIN, "ds-1");
  });

  it("404s when the draft-session detail query returns null", () => {
    queryWorkflowDraftSessionMock.mockReturnValue(null);
    const result = routeGatewayDomainRead(DOMAIN, "workspace/drafts/missing", {});
    expect(result.status).toBe(404);
  });
});

describe("routeGatewayDomainRead — workflows/:id/topology", () => {
  it("routes GET /workflows/:id to the workflow topology (default sub-resource)", () => {
    queryWorkflowTopologyMock.mockReturnValue({ scope: { kind: "workflow", domainId: DOMAIN, workflowId: "wf-1" } });
    const result = routeGatewayDomainRead(DOMAIN, "workflows/wf-1", {});
    expect(result.status).toBe(200);
    expect(queryWorkflowTopologyMock).toHaveBeenCalledWith(DOMAIN, "wf-1");
  });

  it("routes GET /workflows/:id/topology explicitly", () => {
    queryWorkflowTopologyMock.mockReturnValue({ scope: { kind: "workflow", domainId: DOMAIN, workflowId: "wf-1" } });
    const result = routeGatewayDomainRead(DOMAIN, "workflows/wf-1/topology", {});
    expect(result.status).toBe(200);
    expect(queryWorkflowTopologyMock).toHaveBeenCalledWith(DOMAIN, "wf-1");
  });

  it("404s when the topology query returns null", () => {
    queryWorkflowTopologyMock.mockReturnValue(null);
    const result = routeGatewayDomainRead(DOMAIN, "workflows/missing", {});
    expect(result.status).toBe(404);
  });

  it("404s when workflowId segment is missing", () => {
    const result = routeGatewayDomainRead(DOMAIN, "workflows", {});
    expect(result.status).toBe(404);
    expect(queryWorkflowTopologyMock).not.toHaveBeenCalled();
  });
});

describe("routeGatewayDomainRead — workflows/:id/stages/:stageKey", () => {
  it("dispatches to queryWorkflowStageInspector with the decoded stage key", () => {
    queryWorkflowStageInspectorMock.mockReturnValue({ scope: { kind: "stage", domainId: DOMAIN, workflowId: "wf-1", stageKey: "wf-1:phase:0" } });
    const result = routeGatewayDomainRead(DOMAIN, "workflows/wf-1/stages/wf-1%3Aphase%3A0", {});
    expect(result.status).toBe(200);
    expect(queryWorkflowStageInspectorMock).toHaveBeenCalledWith(DOMAIN, "wf-1", "wf-1:phase:0");
  });

  it("404s when the inspector returns null", () => {
    queryWorkflowStageInspectorMock.mockReturnValue(null);
    const result = routeGatewayDomainRead(DOMAIN, "workflows/wf-1/stages/99", {});
    expect(result.status).toBe(404);
  });

  it("404s when stageKey segment is missing", () => {
    const result = routeGatewayDomainRead(DOMAIN, "workflows/wf-1/stages", {});
    expect(result.status).toBe(404);
    expect(queryWorkflowStageInspectorMock).not.toHaveBeenCalled();
  });

  it("404s an unknown workflow sub-resource", () => {
    const result = routeGatewayDomainRead(DOMAIN, "workflows/wf-1/bogus", {});
    expect(result.status).toBe(404);
  });
});
