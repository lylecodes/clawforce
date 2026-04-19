import { describe, expect, it } from "vitest";

import { normalizeEntityKindsConfig, validateEntityKindsInConfig } from "../../src/entities/config.js";

describe("config/entities", () => {
  it("normalizes array states, health arrays, and metadata schema shorthands", () => {
    const kinds = normalizeEntityKindsConfig({
      jurisdiction: {
        title: "Jurisdiction",
        states: ["bootstrapping", "shadow", "active"],
        transitions: [
          { from: "bootstrapping", to: "shadow" },
          {
            from: "shadow",
            to: "active",
            reason_required: true,
            approval_required: true,
            blocked_by_open_issues: true,
            blocked_by_severities: ["high", "critical"],
            blocked_by_issue_types: ["bundle_regression"],
          },
        ],
        health: { values: ["healthy", "warning", "blocked"], default: "warning", clear: "healthy" },
        metadata_schema: {
          region: "string",
          tier: { type: "string", enum: ["city", "state"], required: true },
          activation_blockers: { type: "array" },
        },
        readiness: {
          when_states: ["shadow"],
          blockers_field: "activation_blockers",
          requirements: {
            no_open_issues: true,
            metadata_true: ["signed_off"],
            metadata_equals: { tier: "city" },
          },
          close_tasks_when_ready: {
            title_templates: ["Stand up shadow governance for {{entity.title }}"],
          },
          request_transition_when_ready: {
            to_state: "active",
            reason: "Ready for promotion review",
          },
        },
        issues: {
          auto_sync_health: true,
          state_signals: [
            {
              id: "proposed-onboarding",
              when_states: ["bootstrapping"],
              owner_presence: "missing",
              issue_type: "bundle_regression",
              owner_agent_id: "workflow-steward",
              title_template: "Onboard {{entity.title}}",
            },
          ],
          default_blocking_severities: ["high", "critical"],
          default_health_by_severity: {
            medium: "warning",
            high: "blocked",
          },
          checks: {
            pipeline_health: {
              command: "npm run pipeline:health -- --json",
              parser: {
                type: "json_record_issues",
                records_path: "jurisdictions",
                match_field: "name",
                issue_array_path: "issues",
                issue_type_field: "category",
                issue_type_map: {
                  completeness: "bundle_regression",
                },
                metadata_updates: {
                  completeness_percent: "completeness_pct",
                },
              },
              issue_types: ["bundle_regression"],
              playbook: "rentright-bundle-verify",
            },
          },
          types: {
            bundle_regression: {
              default_severity: "high",
              blocking: true,
              approval_required: true,
              health: "blocked",
              playbook: "rentright-bundle-verify",
              task: {
                enabled: true,
                title_template: "Remediate {{entity.title}}",
                rerun_check_ids: ["pipeline_health"],
                rerun_on_states: ["DONE", "REVIEW"],
                close_task_on_resolved: false,
              },
            },
          },
        },
      },
    });

    expect(kinds.jurisdiction).toBeDefined();
    expect(Object.keys(kinds.jurisdiction!.states)).toEqual(["bootstrapping", "shadow", "active"]);
    expect(kinds.jurisdiction!.health?.default).toBe("warning");
    expect(kinds.jurisdiction!.health?.clear).toBe("healthy");
    expect(kinds.jurisdiction!.transitions[1]!.reasonRequired).toBe(true);
    expect(kinds.jurisdiction!.transitions[1]!.approvalRequired).toBe(true);
    expect(kinds.jurisdiction!.transitions[1]!.blockedByOpenIssues).toBe(true);
    expect(kinds.jurisdiction!.transitions[1]!.blockedBySeverities).toEqual(["high", "critical"]);
    expect(kinds.jurisdiction!.transitions[1]!.blockedByIssueTypes).toEqual(["bundle_regression"]);
    expect(kinds.jurisdiction!.metadataSchema?.region?.type).toBe("string");
    expect(kinds.jurisdiction!.metadataSchema?.tier?.enum).toEqual(["city", "state"]);
    expect(kinds.jurisdiction!.issues?.checks?.pipeline_health?.playbook).toBe("rentright-bundle-verify");
    expect(kinds.jurisdiction!.issues?.checks?.pipeline_health?.parser).toMatchObject({
      type: "json_record_issues",
      recordsPath: "jurisdictions",
      issueTypeMap: {
        completeness: "bundle_regression",
      },
      metadataUpdates: {
        completeness_percent: "completeness_pct",
      },
    });
    expect(kinds.jurisdiction!.issues?.types?.bundle_regression?.health).toBe("blocked");
    expect(kinds.jurisdiction!.issues?.types?.bundle_regression?.task).toEqual({
      enabled: true,
      titleTemplate: "Remediate {{entity.title}}",
      descriptionTemplate: undefined,
      priority: undefined,
      kind: undefined,
      tags: undefined,
      rerunCheckIds: ["pipeline_health"],
      rerunOnStates: ["DONE", "REVIEW"],
      closeTaskOnResolved: false,
    });
    expect(kinds.jurisdiction!.issues?.stateSignals).toEqual([{
      id: "proposed-onboarding",
      whenStates: ["bootstrapping"],
      ownerPresence: "missing",
      issueType: "bundle_regression",
      issueKey: undefined,
      issueKeyTemplate: undefined,
      titleTemplate: "Onboard {{entity.title}}",
      descriptionTemplate: undefined,
      recommendedAction: undefined,
      playbook: undefined,
      ownerAgentId: "workflow-steward",
      severity: undefined,
      blocking: undefined,
      approvalRequired: undefined,
    }]);
    expect(kinds.jurisdiction!.readiness).toEqual({
      whenStates: ["shadow"],
      blockersField: "activation_blockers",
      requirements: {
        noOpenIssues: true,
        metadataTrue: ["signed_off"],
        metadataEquals: { tier: "city" },
        metadataMin: undefined,
      },
      closeTasksWhenReady: {
        titleTemplates: ["Stand up shadow governance for {{entity.title }}"],
      },
      requestTransitionWhenReady: {
        toState: "active",
        reason: "Ready for promotion review",
        actor: undefined,
      },
    });
  });

  it("reports invalid lifecycle definitions from config validation", () => {
    const errors = validateEntityKindsInConfig({
      agents: {},
      entities: {
        jurisdiction: {
          states: {
            active: { initial: true },
            retired: { initial: true },
          },
          transitions: [],
          health: { values: ["healthy", "blocked"], default: "warning", clear: "clearish" },
          metadataSchema: {
            severity: { type: "number", enum: ["bad"] as unknown as string[] },
            activation_blockers: { type: "string" },
          },
          readiness: {
            whenStates: ["shadow"],
            blockersField: "activation_blockers",
            requirements: {
              metadataTrue: ["unknown_field"],
              metadataMin: {
                severity: 100,
              },
            },
            requestTransitionWhenReady: {
              toState: "active",
            },
          },
          issues: {
            stateSignals: [
              {
                whenStates: ["missing_state"],
                ownerPresence: "missing",
                issueType: "missing_issue_type",
                ownerAgentId: "missing-agent",
              },
            ],
            defaultHealthBySeverity: {
              high: "warning",
            },
            checks: {
              pipeline_health: {
                command: "npm run pipeline:health",
                issueTypes: ["missing_issue_type"],
                parser: {
                  type: "json_record_status",
                  recordsPath: "jurisdictions",
                  matchField: "name",
                  statusField: "verdict",
                  issueStates: {
                    blocked: { issueType: "also_missing_issue_type" },
                  },
                },
              },
            },
            types: {
              bundle_regression: {
                defaultSeverity: "severe" as unknown as "low",
                health: "unknown",
                task: {
                  priority: "P9" as unknown as "P1",
                  kind: "chore" as unknown as "bug",
                  rerunOnStates: ["NOT_A_STATE"] as unknown as "DONE"[],
                  rerunCheckIds: ["unknown_check"],
                },
              },
            },
          },
        },
      },
    });

    expect(errors).toEqual(expect.arrayContaining([
      "entities.jurisdiction may define at most one initial state",
      "entities.jurisdiction must define explicit transitions when more than one state exists",
      "entities.jurisdiction.health.default must be one of the declared health values",
      "entities.jurisdiction.health.clear must be one of the declared health values",
      "entities.jurisdiction.metadataSchema.severity.enum is only valid for string fields",
      "entities.jurisdiction.readiness.blockersField must reference an array metadata field",
      "entities.jurisdiction.readiness.requirements.metadataTrue references unknown metadata field \"unknown_field\"",
      "entities.jurisdiction.readiness.whenStates references unknown state \"shadow\"",
      "entities.jurisdiction.readiness.requestTransitionWhenReady requires a valid transition shadow -> active",
      "entities.jurisdiction.issues.defaultHealthBySeverity.high references unknown health \"warning\"",
      "entities.jurisdiction.issues.stateSignals[0].issueType references unknown issue type \"missing_issue_type\"",
      "entities.jurisdiction.issues.stateSignals[0].whenStates references unknown state \"missing_state\"",
      "entities.jurisdiction.issues.stateSignals[0].ownerAgentId references unknown agent \"missing-agent\"",
      "entities.jurisdiction.issues.types.bundle_regression.defaultSeverity must be one of: low, medium, high, critical",
      "entities.jurisdiction.issues.types.bundle_regression.health references unknown health \"unknown\"",
      "entities.jurisdiction.issues.types.bundle_regression.task.priority must be one of: P0, P1, P2, P3",
      "entities.jurisdiction.issues.types.bundle_regression.task.kind must be one of: exercise, bug, feature, infra, research",
      "entities.jurisdiction.issues.types.bundle_regression.task.rerunOnStates includes invalid task state \"NOT_A_STATE\"",
      "entities.jurisdiction.issues.types.bundle_regression.task.rerunCheckIds references unknown check \"unknown_check\"",
      "entities.jurisdiction.issues.checks.pipeline_health.issueTypes references unknown issue type \"missing_issue_type\"",
      "entities.jurisdiction.issues.checks.pipeline_health.parser.issueStates.blocked references unknown issue type \"also_missing_issue_type\"",
    ]));
  });
});
