import { describe, expect, it } from "vitest";

const { buildSetupPreflight } = await import("../../src/setup/preflight.js");

describe("setup/preflight", () => {
  it("models workflow, issue, approval, execution, and mutation preflight scenarios", () => {
    const preflight = buildSetupPreflight({
      domainId: "alpha",
      domainSummary: {
        id: "alpha",
        file: "domains/alpha.yaml",
        exists: true,
        loaded: true,
        enabled: true,
        workflows: ["data-source-onboarding"],
        agentCount: 4,
        jobCount: 1,
        jobs: [
          {
            agentId: "alpha-manager",
            jobId: "intake-triage",
            cron: "*/20 * * * *",
            frequency: null,
            lastScheduledAt: 1_700_000_000_000,
            lastFinishedAt: null,
            lastStatus: null,
            activeTaskId: "task-1",
            activeTaskState: "IN_PROGRESS",
            activeTaskTitle: "Review new onboarding request",
            activeTaskBlockedReason: null,
            activeQueueStatus: "leased",
            activeSessionState: "live",
            nextRunAt: 1_700_000_600_000,
          },
        ],
        controller: {
          state: "live",
          ownerLabel: "controller:alpha",
          heartbeatAgeMs: 2_000,
          activeSessionCount: 1,
          activeDispatchCount: 1,
          currentConfigHash: "hash-current",
          appliedConfigHash: "hash-current",
          appliedConfigVersionId: "cfg-1",
          appliedConfigAppliedAt: 1_700_000_000_000,
          configStatus: "current",
        },
        managerAgentId: "alpha-manager",
        pathCount: 1,
        issueCounts: {
          errors: 0,
          warnings: 0,
          suggestions: 0,
        },
      },
      entities: {
        jurisdiction: {
          runtimeCreate: true,
          states: {
            proposed: { initial: true },
            shadow: {},
            active: {},
          },
          transitions: [
            {
              from: "shadow",
              to: "active",
              approvalRequired: true,
              blockedByOpenIssues: true,
            },
          ],
          issues: {
            types: {
              onboarding_request: {
                defaultSeverity: "medium",
                task: {
                  enabled: true,
                },
              },
            },
            stateSignals: [
              {
                id: "proposed-onboarding-request",
                whenStates: ["proposed"],
                ownerPresence: "missing",
                issueType: "onboarding_request",
                recommendedAction: "Create or update governed onboarding work for this proposed jurisdiction.",
              },
            ],
          },
        },
      },
      execution: {
        mode: "dry_run",
        defaultMutationPolicy: "simulate",
      },
      review: {
        workflowSteward: {
          agentId: "workflow-steward",
          autoProposalThreshold: 3,
          autoProposalReasonCodes: ["verification_environment_blocked", "workflow_gap"],
          proposalCooldownHours: 12,
        },
      },
      configuredAgentIds: ["alpha-manager", "workflow-steward"],
    });

    expect(preflight.counts.ready).toBeGreaterThan(0);
    expect(preflight.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "workflow:data-source-onboarding:intake-triage",
        category: "workflow",
        status: "ready",
      }),
      expect.objectContaining({
        id: "workflow:data-source-onboarding:onboarding-backlog-sweep",
        category: "workflow",
        status: "attention",
      }),
      expect.objectContaining({
        id: "state-signal:jurisdiction:proposed-onboarding-request",
        category: "issue",
        automationState: "auto_handling",
      }),
      expect.objectContaining({
        id: "transition:jurisdiction:shadow:active",
        category: "approval",
        automationState: "needs_human",
      }),
      expect.objectContaining({
        id: "execution:default-mutation-policy",
        category: "execution",
        currentMutationEffect: "simulate",
      }),
      expect.objectContaining({
        id: "mutation:workflow-steward",
        category: "mutation",
        status: "ready",
      }),
    ]));
    expect(preflight.summary).toContain("modeled behavior");

    const workflowScenario = preflight.scenarios.find((entry) => entry.id === "workflow:data-source-onboarding:intake-triage");
    expect(workflowScenario?.predictedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "feed",
        label: "Feed intake item",
      }),
      expect.objectContaining({
        kind: "task",
        label: "Manager intake task",
      }),
    ]));

    const issueScenario = preflight.scenarios.find((entry) => entry.id === "state-signal:jurisdiction:proposed-onboarding-request");
    expect(issueScenario?.predictedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "issue",
        label: "Onboarding Request issue record",
      }),
      expect.objectContaining({
        kind: "task",
        label: "Remediation task",
      }),
    ]));

    const approvalScenario = preflight.scenarios.find((entry) => entry.id === "transition:jurisdiction:shadow:active");
    expect(approvalScenario?.predictedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "proposal",
        label: "Transition proposal",
      }),
      expect.objectContaining({
        kind: "decision",
        label: "Decision inbox item",
      }),
    ]));

    const executionScenario = preflight.scenarios.find((entry) => entry.id === "execution:default-mutation-policy");
    expect(executionScenario?.predictedArtifacts).toEqual([
      expect.objectContaining({
        kind: "simulated_action",
        label: "Simulated action record",
      }),
    ]);

    const mutationScenario = preflight.scenarios.find((entry) => entry.id === "mutation:workflow-steward");
    expect(mutationScenario?.predictedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "proposal",
        label: "Workflow-mutation proposal",
      }),
      expect.objectContaining({
        kind: "task",
        label: "Workflow steward task",
      }),
    ]));
  });

  it("fails closed when no workflow steward is configured", () => {
    const preflight = buildSetupPreflight({
      domainId: "alpha",
      domainSummary: null,
      configuredAgentIds: ["alpha-manager"],
    });

    const scenario = preflight.scenarios.find((entry) => entry.id === "mutation:workflow-steward");
    expect(scenario).toMatchObject({
      status: "attention",
      automationState: "blocked_for_agent",
    });
    expect(scenario?.statusDetail).toContain("workflow-steward");
    expect(scenario?.predictedArtifacts).toEqual([
      expect.objectContaining({
        kind: "feed",
        label: "Feed-only escalation gap",
      }),
    ]);
  });
});
