# ui-dogfood-2026-04-19 18:41 UTC onboarding-backlog-sweep

## Workflow wiring
```sh
src/setup/workflows.ts:4:export const STARTER_WORKFLOW_TYPES = ["data-source-onboarding"] as const;
src/setup/workflows.ts:59:    jobId: "onboarding-backlog-sweep",
src/setup/workflows.ts:76:  "data-source-onboarding": {
src/setup/workflows.ts:77:    id: "data-source-onboarding",
src/setup/workflows.ts:106:        id: "onboarding-backlog-sweep",
src/setup/workflows.ts:107:        jobId: "onboarding-backlog-sweep",
src/setup/workflows.ts:210:  if (workflow !== "data-source-onboarding") {
src/setup/workflows.ts:271:      "onboarding-backlog-sweep": {
src/setup/workflows.ts:428:              id: "proposed-onboarding-request",
src/setup/workflows.ts:446:    template: "data-source-onboarding",
/Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml:2:template: data-source-onboarding
/Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml:4:  - data-source-onboarding
/Users/lylejens/.clawforce/domains/ui-dogfood-2026-04-18.yaml:134:        - id: proposed-onboarding-request
```

## Setup status
```json
{
  "root": "/Users/lylejens/.clawforce",
  "targetDomainId": "ui-dogfood-2026-04-18",
  "valid": true,
  "hasGlobalConfig": true,
  "domainFileIds": [
    "clawforce-dev",
    "ui-dogfood-2026-04-18"
  ],
  "domains": [
    {
      "id": "ui-dogfood-2026-04-18",
      "file": "domains/ui-dogfood-2026-04-18.yaml",
      "exists": true,
      "loaded": true,
      "enabled": true,
      "workflows": [
        "data-source-onboarding"
      ],
      "agentCount": 5,
      "jobCount": 10,
      "jobs": [
        {
          "agentId": "ui-dogfood-2026-04-18-source-onboarding-steward",
          "jobId": "onboarding-backlog-sweep",
          "cron": "*/5 * * * *",
          "frequency": null,
          "lastScheduledAt": 1776622856825,
          "lastFinishedAt": 1776622616926,
          "lastStatus": "scheduled",
          "activeTaskId": "7aff73eb-8750-4b92-b193-fb9829bb31c2",
          "activeTaskState": "ASSIGNED",
          "activeTaskTitle": "Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
          "activeTaskBlockedReason": null,
          "activeQueueStatus": "dispatched",
          "activeSessionState": "none",
          "nextRunAt": 1776622800000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-data-director",
          "jobId": "session_reset",
          "cron": "0 0 * * *",
          "frequency": null,
          "lastScheduledAt": 1776582028198,
          "lastFinishedAt": null,
          "lastStatus": "scheduled",
          "activeTaskId": "2d818822-77de-45f6-852f-cb73a21fbe9e",
          "activeTaskState": "BLOCKED",
          "activeTaskTitle": "Run recurring workflow ui-dogfood-2026-04-18-data-director.session_reset",
          "activeTaskBlockedReason": "Auto-blocked: no activity for 4h",
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776668400000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-integrity-gatekeeper",
          "jobId": "integrity-sweep",
          "cron": "*/30 * * * *",
          "frequency": null,
          "lastScheduledAt": 1776624059599,
          "lastFinishedAt": 1776622077175,
          "lastStatus": "scheduled",
          "activeTaskId": "45a8b28d-e818-4251-af22-63273fe03beb",
          "activeTaskState": "ASSIGNED",
          "activeTaskTitle": "Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776623400000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-data-director",
          "jobId": "memory_review",
          "cron": "0 18 * * *",
          "frequency": null,
          "lastScheduledAt": 1776560411501,
          "lastFinishedAt": null,
          "lastStatus": "scheduled",
          "activeTaskId": "9ba6db15-ef20-43d8-abbb-dcd379b16d51",
          "activeTaskState": "OPEN",
          "activeTaskTitle": "Run recurring workflow ui-dogfood-2026-04-18-data-director.memory_review",
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776646800000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-data-director",
          "jobId": "coordination",
          "cron": "*/30 * * * *",
          "frequency": null,
          "lastScheduledAt": 1776499206611,
          "lastFinishedAt": null,
          "lastStatus": "scheduled",
          "activeTaskId": "4cb2777e-41cb-496c-8066-08e5b19b75d3",
          "activeTaskState": "OPEN",
          "activeTaskTitle": "Run recurring workflow ui-dogfood-2026-04-18-data-director.coordination",
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776501000000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-data-director",
          "jobId": "intake-triage",
          "cron": "*/20 * * * *",
          "frequency": null,
          "lastScheduledAt": 1776498003200,
          "lastFinishedAt": null,
          "lastStatus": "scheduled",
          "activeTaskId": "fe4b8e21-1246-4d3a-9604-b8c96769dfc3",
          "activeTaskState": "OPEN",
          "activeTaskTitle": "Run recurring workflow ui-dogfood-2026-04-18-data-director.intake-triage",
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776499200000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-production-sentinel",
          "jobId": "production-watch",
          "cron": "0 * * * *",
          "frequency": null,
          "lastScheduledAt": 1776621656604,
          "lastFinishedAt": 1776622077185,
          "lastStatus": "completed",
          "activeTaskId": null,
          "activeTaskState": null,
          "activeTaskTitle": null,
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776625200000
        },
        {
          "agentId": "workflow-steward",
          "jobId": "workflow-gap-review",
          "cron": "15 */6 * * *",
          "frequency": null,
          "lastScheduledAt": 1776605387848,
          "lastFinishedAt": 1776611097104,
          "lastStatus": "completed",
          "activeTaskId": null,
          "activeTaskState": null,
          "activeTaskTitle": null,
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776626100000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-data-director",
          "jobId": "standup",
          "cron": "0 9 * * MON-FRI",
          "frequency": null,
          "lastScheduledAt": null,
          "lastFinishedAt": null,
          "lastStatus": null,
          "activeTaskId": null,
          "activeTaskState": null,
          "activeTaskTitle": null,
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1776700800000
        },
        {
          "agentId": "ui-dogfood-2026-04-18-data-director",
          "jobId": "reflection",
          "cron": "0 9 * * FRI",
          "frequency": null,
          "lastScheduledAt": null,
          "lastFinishedAt": null,
          "lastStatus": null,
          "activeTaskId": null,
          "activeTaskState": null,
          "activeTaskTitle": null,
          "activeTaskBlockedReason": null,
          "activeQueueStatus": null,
          "activeSessionState": "none",
          "nextRunAt": 1777046400000
        }
      ],
      "controller": {
        "state": "none",
        "ownerLabel": null,
        "heartbeatAgeMs": null,
        "activeSessionCount": 0,
        "activeDispatchCount": 1,
        "currentConfigHash": "6b3fd80d84c006ecc2c7cf713a4099dad1e02deb9c3767924a3de50c23377752",
        "appliedConfigHash": null,
        "appliedConfigVersionId": null,
        "appliedConfigAppliedAt": null,
        "configStatus": "not-applicable"
      },
      "managerAgentId": "ui-dogfood-2026-04-18-data-director",
      "pathCount": 1,
      "issueCounts": {
        "errors": 0,
        "warnings": 0,
        "suggestions": 0
      }
    }
  ],
  "issueCounts": {
    "errors": 0,
    "warnings": 6,
    "suggestions": 0
  },
  "checks": [
    {
      "id": "global:config",
      "status": "ok",
      "summary": "Global config found at /Users/lylejens/.clawforce/config.yaml."
    },
    {
      "id": "global:domains",
      "status": "ok",
      "summary": "Found 2 domain config file(s)."
    },
    {
      "id": "global:workflow-steward",
      "status": "ok",
      "summary": "Global agent \"workflow-steward\" is configured."
    },
    {
      "id": "global:target-domain",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "ok",
      "summary": "Target domain \"ui-dogfood-2026-04-18\" exists on disk."
    },
    {
      "id": "global:validation",
      "status": "ok",
      "summary": "Setup validation found no blocking issues."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:agents",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "ok",
      "summary": "Domain \"ui-dogfood-2026-04-18\" has 5 configured agent(s)."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:manager",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "ok",
      "summary": "Domain \"ui-dogfood-2026-04-18\" routes manager decisions to \"ui-dogfood-2026-04-18-data-director\"."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:paths",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "ok",
      "summary": "Domain \"ui-dogfood-2026-04-18\" has 1 project path(s) configured."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:runtime-scope",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "ok",
      "summary": "Domain \"ui-dogfood-2026-04-18\" has 5 hard-scoped agent runtime envelope(s).",
      "detail": "ui-dogfood-2026-04-18-data-director -> codex, ui-dogfood-2026-04-18-integrity-gatekeeper -> openclaw, ui-dogfood-2026-04-18-production-sentinel -> openclaw, ui-dogfood-2026-04-18-source-onboarding-steward -> openclaw, workflow-steward -> openclaw"
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:workflow:data-source-onboarding",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "ok",
      "summary": "Domain \"ui-dogfood-2026-04-18\" declares data-source-onboarding and includes the recurring jobs needed to drive it.",
      "detail": "Route new source intake through triage, onboarding, integrity follow-up, and production observation. Present jobs: intake-triage, onboarding-backlog-sweep, integrity-sweep, production-watch."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:controller",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "warn",
      "summary": "Domain \"ui-dogfood-2026-04-18\" has active worker activity under a shared or lease-less controller path.",
      "detail": "active_sessions=0 active_dispatches=1. This usually means work is running under a shared controller, a gateway-managed lease, or a controller that lost local lease visibility.",
      "fix": "Inspect cf running --domain=ui-dogfood-2026-04-18. If this domain should be locally owned, restart cf controller --domain=ui-dogfood-2026-04-18 to re-establish an explicit lease."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:recurring:ui-dogfood-2026-04-18-integrity-gatekeeper:integrity-sweep:orphaned",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "warn",
      "summary": "Recurring workflow \"ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep\" is stranded with task 45a8b28d in ASSIGNED and no live session.",
      "detail": "Task \"Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep\" is no longer attached to a live session. The controller no longer has an active worker session for this recurring run, so the current task will not make progress on its own.",
      "fix": "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=45a8b28d-e818-4251-af22-63273fe03beb --process --domain=ui-dogfood-2026-04-18."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:recurring:ui-dogfood-2026-04-18-data-director:memory_review:orphaned",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "warn",
      "summary": "Recurring workflow \"ui-dogfood-2026-04-18-data-director.memory_review\" is stranded with task 9ba6db15 in OPEN and no live session.",
      "detail": "Task \"Run recurring workflow ui-dogfood-2026-04-18-data-director.memory_review\" is no longer attached to a live session. The controller no longer has an active worker session for this recurring run, so the current task will not make progress on its own.",
      "fix": "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=9ba6db15-ef20-43d8-abbb-dcd379b16d51 --process --domain=ui-dogfood-2026-04-18."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:recurring:ui-dogfood-2026-04-18-data-director:coordination:orphaned",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "warn",
      "summary": "Recurring workflow \"ui-dogfood-2026-04-18-data-director.coordination\" is stranded with task 4cb2777e in OPEN and no live session.",
      "detail": "Task \"Run recurring workflow ui-dogfood-2026-04-18-data-director.coordination\" is no longer attached to a live session. The controller no longer has an active worker session for this recurring run, so the current task will not make progress on its own.",
      "fix": "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=4cb2777e-41cb-496c-8066-08e5b19b75d3 --process --domain=ui-dogfood-2026-04-18."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:recurring:ui-dogfood-2026-04-18-data-director:intake-triage:orphaned",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "warn",
      "summary": "Recurring workflow \"ui-dogfood-2026-04-18-data-director.intake-triage\" is stranded with task fe4b8e21 in OPEN and no live session.",
      "detail": "Task \"Run recurring workflow ui-dogfood-2026-04-18-data-director.intake-triage\" is no longer attached to a live session. The controller no longer has an active worker session for this recurring run, so the current task will not make progress on its own.",
      "fix": "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=fe4b8e21-1246-4d3a-9604-b8c96769dfc3 --process --domain=ui-dogfood-2026-04-18."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:recurring:ui-dogfood-2026-04-18-data-director:session_reset:blocked",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "warn",
      "summary": "Recurring workflow \"ui-dogfood-2026-04-18-data-director.session_reset\" is blocked on task 2d818822.",
      "detail": "Task \"Run recurring workflow ui-dogfood-2026-04-18-data-director.session_reset\" is currently BLOCKED. Latest reason: Auto-blocked: no activity for 4h. A blocked recurring run prevents future schedules from taking over until the task is resolved or replayed.",
      "fix": "Review task 2d818822-77de-45f6-852f-cb73a21fbe9e and either resolve it or replay it before expecting the recurring workflow to run again."
    },
    {
      "id": "domain:ui-dogfood-2026-04-18:validation",
      "domainId": "ui-dogfood-2026-04-18",
      "status": "ok",
      "summary": "Domain \"ui-dogfood-2026-04-18\" passed current setup validation."
    }
  ],
  "issues": [],
  "nextSteps": [
    "Inspect cf running --domain=ui-dogfood-2026-04-18. If this domain should be locally owned, restart cf controller --domain=ui-dogfood-2026-04-18 to re-establish an explicit lease.",
    "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=45a8b28d-e818-4251-af22-63273fe03beb --process --domain=ui-dogfood-2026-04-18.",
    "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=9ba6db15-ef20-43d8-abbb-dcd379b16d51 --process --domain=ui-dogfood-2026-04-18.",
    "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=4cb2777e-41cb-496c-8066-08e5b19b75d3 --process --domain=ui-dogfood-2026-04-18.",
    "Restart cf controller --domain=ui-dogfood-2026-04-18 or requeue the stranded task with cf queue retry --task-id=fe4b8e21-1246-4d3a-9604-b8c96769dfc3 --process --domain=ui-dogfood-2026-04-18.",
    "Review task 2d818822-77de-45f6-852f-cb73a21fbe9e and either resolve it or replay it before expecting the recurring workflow to run again."
  ]
}
```

## Feed
```json
{
  "projectId": "ui-dogfood-2026-04-18",
  "items": [
    {
      "id": "task-1776624109352-0",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "0627a99e-73b4-4816-b456-fb964d8371b3"
      },
      "detectedAt": 1776622616919,
      "updatedAt": 1776622616919,
      "taskId": "0627a99e-73b4-4816-b456-fb964d8371b3",
      "sourceType": "task",
      "sourceId": "0627a99e-73b4-4816-b456-fb964d8371b3",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "0627a99e-73b4-4816-b456-fb964d8371b3",
        "failedAt": 1776622616919
      }
    },
    {
      "id": "task-1776624109352-1",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "df049e20-d789-426c-a783-ad8e9ea820ca"
      },
      "detectedAt": 1776622437347,
      "updatedAt": 1776622437347,
      "taskId": "df049e20-d789-426c-a783-ad8e9ea820ca",
      "sourceType": "task",
      "sourceId": "df049e20-d789-426c-a783-ad8e9ea820ca",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "df049e20-d789-426c-a783-ad8e9ea820ca",
        "failedAt": 1776622437347
      }
    },
    {
      "id": "task-1776624109352-2",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "58f0d393-8970-49c5-8d97-99fd2a344406"
      },
      "detectedAt": 1776622077160,
      "updatedAt": 1776622077160,
      "taskId": "58f0d393-8970-49c5-8d97-99fd2a344406",
      "sourceType": "task",
      "sourceId": "58f0d393-8970-49c5-8d97-99fd2a344406",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "58f0d393-8970-49c5-8d97-99fd2a344406",
        "failedAt": 1776622077160
      }
    },
    {
      "id": "task-1776624109352-3",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "84ba3e3e-1774-455a-a7f1-152035c73139"
      },
      "detectedAt": 1776622077157,
      "updatedAt": 1776622077157,
      "taskId": "84ba3e3e-1774-455a-a7f1-152035c73139",
      "sourceType": "task",
      "sourceId": "84ba3e3e-1774-455a-a7f1-152035c73139",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "84ba3e3e-1774-455a-a7f1-152035c73139",
        "failedAt": 1776622077157
      }
    },
    {
      "id": "task-1776624109352-4",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "5a1de2cd-f0a7-4eec-b457-1e9cdf006d92"
      },
      "detectedAt": 1776621177117,
      "updatedAt": 1776621177117,
      "taskId": "5a1de2cd-f0a7-4eec-b457-1e9cdf006d92",
      "sourceType": "task",
      "sourceId": "5a1de2cd-f0a7-4eec-b457-1e9cdf006d92",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "5a1de2cd-f0a7-4eec-b457-1e9cdf006d92",
        "failedAt": 1776621177117
      }
    },
    {
      "id": "task-1776624109352-5",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "07852b43-c1f7-4411-a1e9-551db4223378"
      },
      "detectedAt": 1776620577140,
      "updatedAt": 1776620577140,
      "taskId": "07852b43-c1f7-4411-a1e9-551db4223378",
      "sourceType": "task",
      "sourceId": "07852b43-c1f7-4411-a1e9-551db4223378",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "07852b43-c1f7-4411-a1e9-551db4223378",
        "failedAt": 1776620577140
      }
    },
    {
      "id": "task-1776624109352-6",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "5a6b4765-9698-4951-a443-8700fa6d46b4"
      },
      "detectedAt": 1776620277098,
      "updatedAt": 1776620277098,
      "taskId": "5a6b4765-9698-4951-a443-8700fa6d46b4",
      "sourceType": "task",
      "sourceId": "5a6b4765-9698-4951-a443-8700fa6d46b4",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "5a6b4765-9698-4951-a443-8700fa6d46b4",
        "failedAt": 1776620277098
      }
    },
    {
      "id": "task-1776624109352-7",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "702fb51c-a06a-4949-ae39-8592507451b3"
      },
      "detectedAt": 1776619977121,
      "updatedAt": 1776619977121,
      "taskId": "702fb51c-a06a-4949-ae39-8592507451b3",
      "sourceType": "task",
      "sourceId": "702fb51c-a06a-4949-ae39-8592507451b3",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "702fb51c-a06a-4949-ae39-8592507451b3",
        "failedAt": 1776619977121
      }
    },
    {
      "id": "task-1776624109352-8",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e1412271-7454-4413-88b8-29f166174ff6"
      },
      "detectedAt": 1776619257052,
      "updatedAt": 1776619257052,
      "taskId": "e1412271-7454-4413-88b8-29f166174ff6",
      "sourceType": "task",
      "sourceId": "e1412271-7454-4413-88b8-29f166174ff6",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e1412271-7454-4413-88b8-29f166174ff6",
        "failedAt": 1776619257052
      }
    },
    {
      "id": "task-1776624109352-9",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "f5c9fbe9-8eaf-4945-895d-0b17bb57db9b"
      },
      "detectedAt": 1776619017768,
      "updatedAt": 1776619017768,
      "taskId": "f5c9fbe9-8eaf-4945-895d-0b17bb57db9b",
      "sourceType": "task",
      "sourceId": "f5c9fbe9-8eaf-4945-895d-0b17bb57db9b",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "f5c9fbe9-8eaf-4945-895d-0b17bb57db9b",
        "failedAt": 1776619017768
      }
    },
    {
      "id": "task-1776624109352-10",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "edcb2e78-449c-422c-b56a-7b8cc45a2162"
      },
      "detectedAt": 1776619017765,
      "updatedAt": 1776619017765,
      "taskId": "edcb2e78-449c-422c-b56a-7b8cc45a2162",
      "sourceType": "task",
      "sourceId": "edcb2e78-449c-422c-b56a-7b8cc45a2162",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "edcb2e78-449c-422c-b56a-7b8cc45a2162",
        "failedAt": 1776619017765
      }
    },
    {
      "id": "task-1776624109352-11",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "412952ef-f10b-4282-8b7a-f7f0bae7375d"
      },
      "detectedAt": 1776617453155,
      "updatedAt": 1776617453155,
      "taskId": "412952ef-f10b-4282-8b7a-f7f0bae7375d",
      "sourceType": "task",
      "sourceId": "412952ef-f10b-4282-8b7a-f7f0bae7375d",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "412952ef-f10b-4282-8b7a-f7f0bae7375d",
        "failedAt": 1776617453155
      }
    },
    {
      "id": "task-1776624109352-12",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "33b6f07c-2a88-4123-94f6-6671b8006a84"
      },
      "detectedAt": 1776614294366,
      "updatedAt": 1776614294366,
      "taskId": "33b6f07c-2a88-4123-94f6-6671b8006a84",
      "sourceType": "task",
      "sourceId": "33b6f07c-2a88-4123-94f6-6671b8006a84",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "33b6f07c-2a88-4123-94f6-6671b8006a84",
        "failedAt": 1776614294366
      }
    },
    {
      "id": "task-1776624109352-13",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "579808f3-2456-42cd-ab77-dede9d5a85dc"
      },
      "detectedAt": 1776612715590,
      "updatedAt": 1776612715590,
      "taskId": "579808f3-2456-42cd-ab77-dede9d5a85dc",
      "sourceType": "task",
      "sourceId": "579808f3-2456-42cd-ab77-dede9d5a85dc",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "579808f3-2456-42cd-ab77-dede9d5a85dc",
        "failedAt": 1776612715590
      }
    },
    {
      "id": "task-1776624109352-14",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "cc864210-46f3-4eb7-a52a-03f048e7cdca"
      },
      "detectedAt": 1776612715584,
      "updatedAt": 1776612715584,
      "taskId": "cc864210-46f3-4eb7-a52a-03f048e7cdca",
      "sourceType": "task",
      "sourceId": "cc864210-46f3-4eb7-a52a-03f048e7cdca",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "cc864210-46f3-4eb7-a52a-03f048e7cdca",
        "failedAt": 1776612715584
      }
    },
    {
      "id": "task-1776624109352-15",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow workflow-steward.workflow-gap-review",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "25b124ce-ab64-409b-8eb0-b8b72816aa87"
      },
      "detectedAt": 1776611096490,
      "updatedAt": 1776611096490,
      "taskId": "25b124ce-ab64-409b-8eb0-b8b72816aa87",
      "sourceType": "task",
      "sourceId": "25b124ce-ab64-409b-8eb0-b8b72816aa87",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "25b124ce-ab64-409b-8eb0-b8b72816aa87",
        "failedAt": 1776611096490
      }
    },
    {
      "id": "task-1776624109352-16",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "ee0fe732-5264-498e-a4ff-1891d723e520"
      },
      "detectedAt": 1776608077934,
      "updatedAt": 1776608077934,
      "taskId": "ee0fe732-5264-498e-a4ff-1891d723e520",
      "sourceType": "task",
      "sourceId": "ee0fe732-5264-498e-a4ff-1891d723e520",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "ee0fe732-5264-498e-a4ff-1891d723e520",
        "failedAt": 1776608077934
      }
    },
    {
      "id": "task-1776624109352-17",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "d9a1a3ce-9142-4c2a-b7ad-66e87b709c1a"
      },
      "detectedAt": 1776608077932,
      "updatedAt": 1776608077932,
      "taskId": "d9a1a3ce-9142-4c2a-b7ad-66e87b709c1a",
      "sourceType": "task",
      "sourceId": "d9a1a3ce-9142-4c2a-b7ad-66e87b709c1a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "d9a1a3ce-9142-4c2a-b7ad-66e87b709c1a",
        "failedAt": 1776608077932
      }
    },
    {
      "id": "task-1776624109352-18",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "b2bae6ce-3428-420f-a9cd-86055eea072d"
      },
      "detectedAt": 1776608077929,
      "updatedAt": 1776608077929,
      "taskId": "b2bae6ce-3428-420f-a9cd-86055eea072d",
      "sourceType": "task",
      "sourceId": "b2bae6ce-3428-420f-a9cd-86055eea072d",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "b2bae6ce-3428-420f-a9cd-86055eea072d",
        "failedAt": 1776608077929
      }
    },
    {
      "id": "task-1776624109352-19",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "209588c7-5274-4771-860e-f5aee4946b32"
      },
      "detectedAt": 1776603441083,
      "updatedAt": 1776603441083,
      "taskId": "209588c7-5274-4771-860e-f5aee4946b32",
      "sourceType": "task",
      "sourceId": "209588c7-5274-4771-860e-f5aee4946b32",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "209588c7-5274-4771-860e-f5aee4946b32",
        "failedAt": 1776603441083
      }
    },
    {
      "id": "task-1776624109352-20",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "b1a8edbf-f00a-4676-83ec-442b44dcf001"
      },
      "detectedAt": 1776603441081,
      "updatedAt": 1776603441081,
      "taskId": "b1a8edbf-f00a-4676-83ec-442b44dcf001",
      "sourceType": "task",
      "sourceId": "b1a8edbf-f00a-4676-83ec-442b44dcf001",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "b1a8edbf-f00a-4676-83ec-442b44dcf001",
        "failedAt": 1776603441081
      }
    },
    {
      "id": "task-1776624109352-21",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "9b7c78f5-6329-4aab-8d29-98a0c1d449b8"
      },
      "detectedAt": 1776603441077,
      "updatedAt": 1776603441077,
      "taskId": "9b7c78f5-6329-4aab-8d29-98a0c1d449b8",
      "sourceType": "task",
      "sourceId": "9b7c78f5-6329-4aab-8d29-98a0c1d449b8",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "9b7c78f5-6329-4aab-8d29-98a0c1d449b8",
        "failedAt": 1776603441077
      }
    },
    {
      "id": "task-1776624109352-22",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "65a3804d-957a-4498-bc23-99ef6208ef77"
      },
      "detectedAt": 1776599986977,
      "updatedAt": 1776599986977,
      "taskId": "65a3804d-957a-4498-bc23-99ef6208ef77",
      "sourceType": "task",
      "sourceId": "65a3804d-957a-4498-bc23-99ef6208ef77",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "65a3804d-957a-4498-bc23-99ef6208ef77",
        "failedAt": 1776599986977
      }
    },
    {
      "id": "task-1776624109352-23",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "4e5d91fa-d055-40b4-9b16-01308b7eedf7"
      },
      "detectedAt": 1776599986975,
      "updatedAt": 1776599986975,
      "taskId": "4e5d91fa-d055-40b4-9b16-01308b7eedf7",
      "sourceType": "task",
      "sourceId": "4e5d91fa-d055-40b4-9b16-01308b7eedf7",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "4e5d91fa-d055-40b4-9b16-01308b7eedf7",
        "failedAt": 1776599986975
      }
    },
    {
      "id": "task-1776624109352-24",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "c040bfb2-ebfb-4c74-b84a-7019d4455a77"
      },
      "detectedAt": 1776598034361,
      "updatedAt": 1776598034361,
      "taskId": "c040bfb2-ebfb-4c74-b84a-7019d4455a77",
      "sourceType": "task",
      "sourceId": "c040bfb2-ebfb-4c74-b84a-7019d4455a77",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "c040bfb2-ebfb-4c74-b84a-7019d4455a77",
        "failedAt": 1776598034361
      }
    },
    {
      "id": "task-1776624109352-25",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "be47ade7-1e25-4ced-a4da-ccc26dbad806"
      },
      "detectedAt": 1776597733669,
      "updatedAt": 1776597733669,
      "taskId": "be47ade7-1e25-4ced-a4da-ccc26dbad806",
      "sourceType": "task",
      "sourceId": "be47ade7-1e25-4ced-a4da-ccc26dbad806",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "be47ade7-1e25-4ced-a4da-ccc26dbad806",
        "failedAt": 1776597733669
      }
    },
    {
      "id": "task-1776624109352-26",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "1b7495b4-2cc4-4d7c-89c1-65cd3b7d6e17"
      },
      "detectedAt": 1776597733666,
      "updatedAt": 1776597733666,
      "taskId": "1b7495b4-2cc4-4d7c-89c1-65cd3b7d6e17",
      "sourceType": "task",
      "sourceId": "1b7495b4-2cc4-4d7c-89c1-65cd3b7d6e17",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "1b7495b4-2cc4-4d7c-89c1-65cd3b7d6e17",
        "failedAt": 1776597733666
      }
    },
    {
      "id": "task-1776624109352-27",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "59be8101-9ed9-4fd0-bbd0-bf7090380017"
      },
      "detectedAt": 1776596569300,
      "updatedAt": 1776596569300,
      "taskId": "59be8101-9ed9-4fd0-bbd0-bf7090380017",
      "sourceType": "task",
      "sourceId": "59be8101-9ed9-4fd0-bbd0-bf7090380017",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "59be8101-9ed9-4fd0-bbd0-bf7090380017",
        "failedAt": 1776596569300
      }
    },
    {
      "id": "task-1776624109352-28",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "d5385f10-41c1-4786-a3f7-ab3fa6808aa6"
      },
      "detectedAt": 1776595181536,
      "updatedAt": 1776595181536,
      "taskId": "d5385f10-41c1-4786-a3f7-ab3fa6808aa6",
      "sourceType": "task",
      "sourceId": "d5385f10-41c1-4786-a3f7-ab3fa6808aa6",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "d5385f10-41c1-4786-a3f7-ab3fa6808aa6",
        "failedAt": 1776595181536
      }
    },
    {
      "id": "task-1776624109352-29",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "9005baed-4e41-46c7-8dca-a587aaaf0f81"
      },
      "detectedAt": 1776595181522,
      "updatedAt": 1776595181522,
      "taskId": "9005baed-4e41-46c7-8dca-a587aaaf0f81",
      "sourceType": "task",
      "sourceId": "9005baed-4e41-46c7-8dca-a587aaaf0f81",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "9005baed-4e41-46c7-8dca-a587aaaf0f81",
        "failedAt": 1776595181522
      }
    },
    {
      "id": "task-1776624109352-30",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "4ac262c6-1243-4a34-a0fe-b0c41e273657"
      },
      "detectedAt": 1776593954380,
      "updatedAt": 1776593954380,
      "taskId": "4ac262c6-1243-4a34-a0fe-b0c41e273657",
      "sourceType": "task",
      "sourceId": "4ac262c6-1243-4a34-a0fe-b0c41e273657",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "4ac262c6-1243-4a34-a0fe-b0c41e273657",
        "failedAt": 1776593954380
      }
    },
    {
      "id": "task-1776624109352-31",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e5b50b82-e962-4459-81db-5714f227f51f"
      },
      "detectedAt": 1776593255977,
      "updatedAt": 1776593255977,
      "taskId": "e5b50b82-e962-4459-81db-5714f227f51f",
      "sourceType": "task",
      "sourceId": "e5b50b82-e962-4459-81db-5714f227f51f",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e5b50b82-e962-4459-81db-5714f227f51f",
        "failedAt": 1776593255977
      }
    },
    {
      "id": "task-1776624109352-32",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "358935d2-3533-439b-a59b-d1a57ec735a8"
      },
      "detectedAt": 1776593255976,
      "updatedAt": 1776593255976,
      "taskId": "358935d2-3533-439b-a59b-d1a57ec735a8",
      "sourceType": "task",
      "sourceId": "358935d2-3533-439b-a59b-d1a57ec735a8",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "358935d2-3533-439b-a59b-d1a57ec735a8",
        "failedAt": 1776593255976
      }
    },
    {
      "id": "task-1776624109352-33",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "ecb8843b-cc9d-474a-a484-9f82b8d816f2"
      },
      "detectedAt": 1776593195479,
      "updatedAt": 1776593195479,
      "taskId": "ecb8843b-cc9d-474a-a484-9f82b8d816f2",
      "sourceType": "task",
      "sourceId": "ecb8843b-cc9d-474a-a484-9f82b8d816f2",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "ecb8843b-cc9d-474a-a484-9f82b8d816f2",
        "failedAt": 1776593195479
      }
    },
    {
      "id": "task-1776624109352-34",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "aa0fbcad-24a9-4685-b30e-b273b810e15a"
      },
      "detectedAt": 1776592955938,
      "updatedAt": 1776592955938,
      "taskId": "aa0fbcad-24a9-4685-b30e-b273b810e15a",
      "sourceType": "task",
      "sourceId": "aa0fbcad-24a9-4685-b30e-b273b810e15a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "aa0fbcad-24a9-4685-b30e-b273b810e15a",
        "failedAt": 1776592955938
      }
    },
    {
      "id": "task-1776624109352-35",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "c649598a-d8a8-47f9-a65a-bf910ca32b03"
      },
      "detectedAt": 1776592355923,
      "updatedAt": 1776592355923,
      "taskId": "c649598a-d8a8-47f9-a65a-bf910ca32b03",
      "sourceType": "task",
      "sourceId": "c649598a-d8a8-47f9-a65a-bf910ca32b03",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "c649598a-d8a8-47f9-a65a-bf910ca32b03",
        "failedAt": 1776592355923
      }
    },
    {
      "id": "task-1776624109352-36",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "097a6cc3-418e-491e-8a1a-52619adf1768"
      },
      "detectedAt": 1776591515909,
      "updatedAt": 1776591515909,
      "taskId": "097a6cc3-418e-491e-8a1a-52619adf1768",
      "sourceType": "task",
      "sourceId": "097a6cc3-418e-491e-8a1a-52619adf1768",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "097a6cc3-418e-491e-8a1a-52619adf1768",
        "failedAt": 1776591515909
      }
    },
    {
      "id": "task-1776624109352-37",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "a5a66bd3-f1ea-48c3-a5f5-37f3cb4f58e7"
      },
      "detectedAt": 1776590795391,
      "updatedAt": 1776590795391,
      "taskId": "a5a66bd3-f1ea-48c3-a5f5-37f3cb4f58e7",
      "sourceType": "task",
      "sourceId": "a5a66bd3-f1ea-48c3-a5f5-37f3cb4f58e7",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "a5a66bd3-f1ea-48c3-a5f5-37f3cb4f58e7",
        "failedAt": 1776590795391
      }
    },
    {
      "id": "task-1776624109352-38",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "4c641201-d963-486b-9e28-3c8df1251641"
      },
      "detectedAt": 1776590555165,
      "updatedAt": 1776590555165,
      "taskId": "4c641201-d963-486b-9e28-3c8df1251641",
      "sourceType": "task",
      "sourceId": "4c641201-d963-486b-9e28-3c8df1251641",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "4c641201-d963-486b-9e28-3c8df1251641",
        "failedAt": 1776590555165
      }
    },
    {
      "id": "task-1776624109352-39",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "765996e4-6c67-4246-8b2a-98b6629bb09c"
      },
      "detectedAt": 1776590015144,
      "updatedAt": 1776590015144,
      "taskId": "765996e4-6c67-4246-8b2a-98b6629bb09c",
      "sourceType": "task",
      "sourceId": "765996e4-6c67-4246-8b2a-98b6629bb09c",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "765996e4-6c67-4246-8b2a-98b6629bb09c",
        "failedAt": 1776590015144
      }
    },
    {
      "id": "task-1776624109352-40",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "3e06cfbd-65bc-4b02-b6ff-1d12bf88aed1"
      },
      "detectedAt": 1776589652244,
      "updatedAt": 1776589652244,
      "taskId": "3e06cfbd-65bc-4b02-b6ff-1d12bf88aed1",
      "sourceType": "task",
      "sourceId": "3e06cfbd-65bc-4b02-b6ff-1d12bf88aed1",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "3e06cfbd-65bc-4b02-b6ff-1d12bf88aed1",
        "failedAt": 1776589652244
      }
    },
    {
      "id": "task-1776624109352-41",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "353aceed-d121-4dbe-8ea0-1c7ea078dff2"
      },
      "detectedAt": 1776589652241,
      "updatedAt": 1776589652241,
      "taskId": "353aceed-d121-4dbe-8ea0-1c7ea078dff2",
      "sourceType": "task",
      "sourceId": "353aceed-d121-4dbe-8ea0-1c7ea078dff2",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "353aceed-d121-4dbe-8ea0-1c7ea078dff2",
        "failedAt": 1776589652241
      }
    },
    {
      "id": "task-1776624109352-42",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "a3f22620-f5d9-47c3-b235-2069c2bd88b2"
      },
      "detectedAt": 1776588152009,
      "updatedAt": 1776588152009,
      "taskId": "a3f22620-f5d9-47c3-b235-2069c2bd88b2",
      "sourceType": "task",
      "sourceId": "a3f22620-f5d9-47c3-b235-2069c2bd88b2",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "a3f22620-f5d9-47c3-b235-2069c2bd88b2",
        "failedAt": 1776588152009
      }
    },
    {
      "id": "task-1776624109352-43",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "176d3715-6e62-4dd0-a046-34aea68741f5"
      },
      "detectedAt": 1776587851964,
      "updatedAt": 1776587851964,
      "taskId": "176d3715-6e62-4dd0-a046-34aea68741f5",
      "sourceType": "task",
      "sourceId": "176d3715-6e62-4dd0-a046-34aea68741f5",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "176d3715-6e62-4dd0-a046-34aea68741f5",
        "failedAt": 1776587851964
      }
    },
    {
      "id": "task-1776624109352-44",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "47fde5d3-cdd4-4cf9-bd99-aef7c60a89fa"
      },
      "detectedAt": 1776587611931,
      "updatedAt": 1776587611931,
      "taskId": "47fde5d3-cdd4-4cf9-bd99-aef7c60a89fa",
      "sourceType": "task",
      "sourceId": "47fde5d3-cdd4-4cf9-bd99-aef7c60a89fa",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "47fde5d3-cdd4-4cf9-bd99-aef7c60a89fa",
        "failedAt": 1776587611931
      }
    },
    {
      "id": "task-1776624109352-45",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "a6968e67-f252-4b39-823f-d44d1924afd9"
      },
      "detectedAt": 1776586351756,
      "updatedAt": 1776586351756,
      "taskId": "a6968e67-f252-4b39-823f-d44d1924afd9",
      "sourceType": "task",
      "sourceId": "a6968e67-f252-4b39-823f-d44d1924afd9",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "a6968e67-f252-4b39-823f-d44d1924afd9",
        "failedAt": 1776586351756
      }
    },
    {
      "id": "task-1776624109352-46",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "019b7286-df22-48c5-81ef-c97d0688fa48"
      },
      "detectedAt": 1776586051603,
      "updatedAt": 1776586051603,
      "taskId": "019b7286-df22-48c5-81ef-c97d0688fa48",
      "sourceType": "task",
      "sourceId": "019b7286-df22-48c5-81ef-c97d0688fa48",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "019b7286-df22-48c5-81ef-c97d0688fa48",
        "failedAt": 1776586051603
      }
    },
    {
      "id": "task-1776624109352-47",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "db46351e-fe4b-4c04-ae34-35a4db4fef9a"
      },
      "detectedAt": 1776586051601,
      "updatedAt": 1776586051601,
      "taskId": "db46351e-fe4b-4c04-ae34-35a4db4fef9a",
      "sourceType": "task",
      "sourceId": "db46351e-fe4b-4c04-ae34-35a4db4fef9a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "db46351e-fe4b-4c04-ae34-35a4db4fef9a",
        "failedAt": 1776586051601
      }
    },
    {
      "id": "task-1776624109352-48",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow workflow-steward.workflow-gap-review",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "f7ecbb45-a315-4fb5-a9a2-6f4414c7325b"
      },
      "detectedAt": 1776585328823,
      "updatedAt": 1776585328823,
      "taskId": "f7ecbb45-a315-4fb5-a9a2-6f4414c7325b",
      "sourceType": "task",
      "sourceId": "f7ecbb45-a315-4fb5-a9a2-6f4414c7325b",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "f7ecbb45-a315-4fb5-a9a2-6f4414c7325b",
        "failedAt": 1776585328823
      }
    },
    {
      "id": "task-1776624109352-49",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "6f879c44-b290-41a4-9257-bc38ced21b47"
      },
      "detectedAt": 1776585028846,
      "updatedAt": 1776585028846,
      "taskId": "6f879c44-b290-41a4-9257-bc38ced21b47",
      "sourceType": "task",
      "sourceId": "6f879c44-b290-41a4-9257-bc38ced21b47",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "6f879c44-b290-41a4-9257-bc38ced21b47",
        "failedAt": 1776585028846
      }
    },
    {
      "id": "task-1776624109352-50",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "6c6488eb-ea1d-4277-bf0f-2bb28ea54dfb"
      },
      "detectedAt": 1776584908819,
      "updatedAt": 1776584908819,
      "taskId": "6c6488eb-ea1d-4277-bf0f-2bb28ea54dfb",
      "sourceType": "task",
      "sourceId": "6c6488eb-ea1d-4277-bf0f-2bb28ea54dfb",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "6c6488eb-ea1d-4277-bf0f-2bb28ea54dfb",
        "failedAt": 1776584908819
      }
    },
    {
      "id": "task-1776624109352-51",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "8da0b547-9c54-40ac-99ab-5aa7c2b96c23"
      },
      "detectedAt": 1776582448768,
      "updatedAt": 1776582448768,
      "taskId": "8da0b547-9c54-40ac-99ab-5aa7c2b96c23",
      "sourceType": "task",
      "sourceId": "8da0b547-9c54-40ac-99ab-5aa7c2b96c23",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "8da0b547-9c54-40ac-99ab-5aa7c2b96c23",
        "failedAt": 1776582448768
      }
    },
    {
      "id": "task-1776624109352-52",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e58e8edd-f4ed-4ac2-b96d-cb089db6caed"
      },
      "detectedAt": 1776582448766,
      "updatedAt": 1776582448766,
      "taskId": "e58e8edd-f4ed-4ac2-b96d-cb089db6caed",
      "sourceType": "task",
      "sourceId": "e58e8edd-f4ed-4ac2-b96d-cb089db6caed",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e58e8edd-f4ed-4ac2-b96d-cb089db6caed",
        "failedAt": 1776582448766
      }
    },
    {
      "id": "task-1776624109352-53",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "ad94468b-2e1c-44db-a54d-dbe6ce6f1992"
      },
      "detectedAt": 1776580648775,
      "updatedAt": 1776580648775,
      "taskId": "ad94468b-2e1c-44db-a54d-dbe6ce6f1992",
      "sourceType": "task",
      "sourceId": "ad94468b-2e1c-44db-a54d-dbe6ce6f1992",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "ad94468b-2e1c-44db-a54d-dbe6ce6f1992",
        "failedAt": 1776580648775
      }
    },
    {
      "id": "task-1776624109352-54",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "26d30049-7081-4608-a10f-72402757250f"
      },
      "detectedAt": 1776580648771,
      "updatedAt": 1776580648771,
      "taskId": "26d30049-7081-4608-a10f-72402757250f",
      "sourceType": "task",
      "sourceId": "26d30049-7081-4608-a10f-72402757250f",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "26d30049-7081-4608-a10f-72402757250f",
        "failedAt": 1776580648771
      }
    },
    {
      "id": "task-1776624109352-55",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "c6c68039-58d7-4ebc-b023-120d4970bf1a"
      },
      "detectedAt": 1776580108741,
      "updatedAt": 1776580108741,
      "taskId": "c6c68039-58d7-4ebc-b023-120d4970bf1a",
      "sourceType": "task",
      "sourceId": "c6c68039-58d7-4ebc-b023-120d4970bf1a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "c6c68039-58d7-4ebc-b023-120d4970bf1a",
        "failedAt": 1776580108741
      }
    },
    {
      "id": "task-1776624109352-56",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "365dab77-e39d-437d-8773-49c908a5f371"
      },
      "detectedAt": 1776578968484,
      "updatedAt": 1776578968484,
      "taskId": "365dab77-e39d-437d-8773-49c908a5f371",
      "sourceType": "task",
      "sourceId": "365dab77-e39d-437d-8773-49c908a5f371",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "365dab77-e39d-437d-8773-49c908a5f371",
        "failedAt": 1776578968484
      }
    },
    {
      "id": "task-1776624109352-57",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "d5c9d7cd-0024-4601-8693-40baa9f40f0c"
      },
      "detectedAt": 1776578845263,
      "updatedAt": 1776578845263,
      "taskId": "d5c9d7cd-0024-4601-8693-40baa9f40f0c",
      "sourceType": "task",
      "sourceId": "d5c9d7cd-0024-4601-8693-40baa9f40f0c",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "d5c9d7cd-0024-4601-8693-40baa9f40f0c",
        "failedAt": 1776578845263
      }
    },
    {
      "id": "task-1776624109352-58",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "86995b66-2194-4f32-a40d-aaef6161d73a"
      },
      "detectedAt": 1776578845261,
      "updatedAt": 1776578845261,
      "taskId": "86995b66-2194-4f32-a40d-aaef6161d73a",
      "sourceType": "task",
      "sourceId": "86995b66-2194-4f32-a40d-aaef6161d73a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "86995b66-2194-4f32-a40d-aaef6161d73a",
        "failedAt": 1776578845261
      }
    },
    {
      "id": "task-1776624109352-59",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "275327dd-f98d-4b10-a7b2-0a2b810ac2f5"
      },
      "detectedAt": 1776577705258,
      "updatedAt": 1776577705258,
      "taskId": "275327dd-f98d-4b10-a7b2-0a2b810ac2f5",
      "sourceType": "task",
      "sourceId": "275327dd-f98d-4b10-a7b2-0a2b810ac2f5",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "275327dd-f98d-4b10-a7b2-0a2b810ac2f5",
        "failedAt": 1776577705258
      }
    },
    {
      "id": "task-1776624109352-60",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "5d5a41a6-7aa9-42ed-bb0f-c1231d6adbf7"
      },
      "detectedAt": 1776577105211,
      "updatedAt": 1776577105211,
      "taskId": "5d5a41a6-7aa9-42ed-bb0f-c1231d6adbf7",
      "sourceType": "task",
      "sourceId": "5d5a41a6-7aa9-42ed-bb0f-c1231d6adbf7",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "5d5a41a6-7aa9-42ed-bb0f-c1231d6adbf7",
        "failedAt": 1776577105211
      }
    },
    {
      "id": "task-1776624109352-61",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "f168e2fe-b403-46c3-94b9-a5b0592f4c2d"
      },
      "detectedAt": 1776575845208,
      "updatedAt": 1776575845208,
      "taskId": "f168e2fe-b403-46c3-94b9-a5b0592f4c2d",
      "sourceType": "task",
      "sourceId": "f168e2fe-b403-46c3-94b9-a5b0592f4c2d",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "f168e2fe-b403-46c3-94b9-a5b0592f4c2d",
        "failedAt": 1776575845208
      }
    },
    {
      "id": "task-1776624109352-62",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "3197eaf9-dc91-41ac-aa9f-173cc9adaf67"
      },
      "detectedAt": 1776575245153,
      "updatedAt": 1776575245153,
      "taskId": "3197eaf9-dc91-41ac-aa9f-173cc9adaf67",
      "sourceType": "task",
      "sourceId": "3197eaf9-dc91-41ac-aa9f-173cc9adaf67",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "3197eaf9-dc91-41ac-aa9f-173cc9adaf67",
        "failedAt": 1776575245153
      }
    },
    {
      "id": "task-1776624109352-63",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "665539ef-5fcf-494a-be0e-e855aa221793"
      },
      "detectedAt": 1776575245152,
      "updatedAt": 1776575245152,
      "taskId": "665539ef-5fcf-494a-be0e-e855aa221793",
      "sourceType": "task",
      "sourceId": "665539ef-5fcf-494a-be0e-e855aa221793",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "665539ef-5fcf-494a-be0e-e855aa221793",
        "failedAt": 1776575245152
      }
    },
    {
      "id": "task-1776624109352-64",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "97b773e3-4008-4110-839d-69e236619d72"
      },
      "detectedAt": 1776575245143,
      "updatedAt": 1776575245143,
      "taskId": "97b773e3-4008-4110-839d-69e236619d72",
      "sourceType": "task",
      "sourceId": "97b773e3-4008-4110-839d-69e236619d72",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "97b773e3-4008-4110-839d-69e236619d72",
        "failedAt": 1776575245143
      }
    },
    {
      "id": "task-1776624109352-65",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "8b0df167-5cd6-44ea-b902-1dbe71658136"
      },
      "detectedAt": 1776574765070,
      "updatedAt": 1776574765070,
      "taskId": "8b0df167-5cd6-44ea-b902-1dbe71658136",
      "sourceType": "task",
      "sourceId": "8b0df167-5cd6-44ea-b902-1dbe71658136",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "8b0df167-5cd6-44ea-b902-1dbe71658136",
        "failedAt": 1776574765070
      }
    },
    {
      "id": "task-1776624109352-66",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "5dc6cea7-59d8-4b34-8419-ff971c8d2927"
      },
      "detectedAt": 1776574525086,
      "updatedAt": 1776574525086,
      "taskId": "5dc6cea7-59d8-4b34-8419-ff971c8d2927",
      "sourceType": "task",
      "sourceId": "5dc6cea7-59d8-4b34-8419-ff971c8d2927",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "5dc6cea7-59d8-4b34-8419-ff971c8d2927",
        "failedAt": 1776574525086
      }
    },
    {
      "id": "task-1776624109352-67",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "4fb9eb4d-7cd6-4568-9ff4-3b8bcf029d24"
      },
      "detectedAt": 1776571945059,
      "updatedAt": 1776571945059,
      "taskId": "4fb9eb4d-7cd6-4568-9ff4-3b8bcf029d24",
      "sourceType": "task",
      "sourceId": "4fb9eb4d-7cd6-4568-9ff4-3b8bcf029d24",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "4fb9eb4d-7cd6-4568-9ff4-3b8bcf029d24",
        "failedAt": 1776571945059
      }
    },
    {
      "id": "task-1776624109352-68",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "f6f9b1e9-5c12-4bcc-95eb-7e670e6166d1"
      },
      "detectedAt": 1776571764492,
      "updatedAt": 1776571764492,
      "taskId": "f6f9b1e9-5c12-4bcc-95eb-7e670e6166d1",
      "sourceType": "task",
      "sourceId": "f6f9b1e9-5c12-4bcc-95eb-7e670e6166d1",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "f6f9b1e9-5c12-4bcc-95eb-7e670e6166d1",
        "failedAt": 1776571764492
      }
    },
    {
      "id": "task-1776624109352-69",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "5a41fd66-c419-4127-9135-694f963e683b"
      },
      "detectedAt": 1776571644128,
      "updatedAt": 1776571644128,
      "taskId": "5a41fd66-c419-4127-9135-694f963e683b",
      "sourceType": "task",
      "sourceId": "5a41fd66-c419-4127-9135-694f963e683b",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "5a41fd66-c419-4127-9135-694f963e683b",
        "failedAt": 1776571644128
      }
    },
    {
      "id": "task-1776624109352-70",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e20ff9d2-f27e-4669-82f1-62d92e99f312"
      },
      "detectedAt": 1776571644125,
      "updatedAt": 1776571644125,
      "taskId": "e20ff9d2-f27e-4669-82f1-62d92e99f312",
      "sourceType": "task",
      "sourceId": "e20ff9d2-f27e-4669-82f1-62d92e99f312",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e20ff9d2-f27e-4669-82f1-62d92e99f312",
        "failedAt": 1776571644125
      }
    },
    {
      "id": "task-1776624109352-71",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "c83f75ee-3c37-42bb-9448-51e758494676"
      },
      "detectedAt": 1776570439451,
      "updatedAt": 1776570439451,
      "taskId": "c83f75ee-3c37-42bb-9448-51e758494676",
      "sourceType": "task",
      "sourceId": "c83f75ee-3c37-42bb-9448-51e758494676",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "c83f75ee-3c37-42bb-9448-51e758494676",
        "failedAt": 1776570439451
      }
    },
    {
      "id": "task-1776624109352-72",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "9402993d-ee6d-4b0b-acd3-568ad1fde4d0"
      },
      "detectedAt": 1776570439447,
      "updatedAt": 1776570439447,
      "taskId": "9402993d-ee6d-4b0b-acd3-568ad1fde4d0",
      "sourceType": "task",
      "sourceId": "9402993d-ee6d-4b0b-acd3-568ad1fde4d0",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "9402993d-ee6d-4b0b-acd3-568ad1fde4d0",
        "failedAt": 1776570439447
      }
    },
    {
      "id": "task-1776624109352-73",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e25726cb-6fba-4524-8033-d8edcb34fa44"
      },
      "detectedAt": 1776569836872,
      "updatedAt": 1776569836872,
      "taskId": "e25726cb-6fba-4524-8033-d8edcb34fa44",
      "sourceType": "task",
      "sourceId": "e25726cb-6fba-4524-8033-d8edcb34fa44",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e25726cb-6fba-4524-8033-d8edcb34fa44",
        "failedAt": 1776569836872
      }
    },
    {
      "id": "task-1776624109352-74",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "b6182c27-c07d-470c-a773-052cd84b14a0"
      },
      "detectedAt": 1776568635755,
      "updatedAt": 1776568635755,
      "taskId": "b6182c27-c07d-470c-a773-052cd84b14a0",
      "sourceType": "task",
      "sourceId": "b6182c27-c07d-470c-a773-052cd84b14a0",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "b6182c27-c07d-470c-a773-052cd84b14a0",
        "failedAt": 1776568635755
      }
    },
    {
      "id": "task-1776624109352-75",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e1294480-61df-4492-8da1-01dcc2de4cc1"
      },
      "detectedAt": 1776568155664,
      "updatedAt": 1776568155664,
      "taskId": "e1294480-61df-4492-8da1-01dcc2de4cc1",
      "sourceType": "task",
      "sourceId": "e1294480-61df-4492-8da1-01dcc2de4cc1",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e1294480-61df-4492-8da1-01dcc2de4cc1",
        "failedAt": 1776568155664
      }
    },
    {
      "id": "task-1776624109352-76",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "8a6da128-4569-41e2-ab02-ba1829b76029"
      },
      "detectedAt": 1776568035132,
      "updatedAt": 1776568035132,
      "taskId": "8a6da128-4569-41e2-ab02-ba1829b76029",
      "sourceType": "task",
      "sourceId": "8a6da128-4569-41e2-ab02-ba1829b76029",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "8a6da128-4569-41e2-ab02-ba1829b76029",
        "failedAt": 1776568035132
      }
    },
    {
      "id": "task-1776624109352-77",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "8ebc5036-6851-4821-bb24-b2afeff6c867"
      },
      "detectedAt": 1776568035128,
      "updatedAt": 1776568035128,
      "taskId": "8ebc5036-6851-4821-bb24-b2afeff6c867",
      "sourceType": "task",
      "sourceId": "8ebc5036-6851-4821-bb24-b2afeff6c867",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "8ebc5036-6851-4821-bb24-b2afeff6c867",
        "failedAt": 1776568035128
      }
    },
    {
      "id": "task-1776624109352-78",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "0833ef31-aeeb-4762-836b-58cf4f6b5d0e"
      },
      "detectedAt": 1776567554805,
      "updatedAt": 1776567554805,
      "taskId": "0833ef31-aeeb-4762-836b-58cf4f6b5d0e",
      "sourceType": "task",
      "sourceId": "0833ef31-aeeb-4762-836b-58cf4f6b5d0e",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "0833ef31-aeeb-4762-836b-58cf4f6b5d0e",
        "failedAt": 1776567554805
      }
    },
    {
      "id": "task-1776624109352-79",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "42743bbc-6d58-491f-b367-23db7527c4a6"
      },
      "detectedAt": 1776564554491,
      "updatedAt": 1776564554491,
      "taskId": "42743bbc-6d58-491f-b367-23db7527c4a6",
      "sourceType": "task",
      "sourceId": "42743bbc-6d58-491f-b367-23db7527c4a6",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "42743bbc-6d58-491f-b367-23db7527c4a6",
        "failedAt": 1776564554491
      }
    },
    {
      "id": "task-1776624109352-80",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "3cce2456-bb8b-4857-b8bc-79a297c315e9"
      },
      "detectedAt": 1776564434520,
      "updatedAt": 1776564434520,
      "taskId": "3cce2456-bb8b-4857-b8bc-79a297c315e9",
      "sourceType": "task",
      "sourceId": "3cce2456-bb8b-4857-b8bc-79a297c315e9",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "3cce2456-bb8b-4857-b8bc-79a297c315e9",
        "failedAt": 1776564434520
      }
    },
    {
      "id": "task-1776624109352-81",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "15d1bb52-90f2-4bf1-a9d6-172ddf8b6deb"
      },
      "detectedAt": 1776564434517,
      "updatedAt": 1776564434517,
      "taskId": "15d1bb52-90f2-4bf1-a9d6-172ddf8b6deb",
      "sourceType": "task",
      "sourceId": "15d1bb52-90f2-4bf1-a9d6-172ddf8b6deb",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "15d1bb52-90f2-4bf1-a9d6-172ddf8b6deb",
        "failedAt": 1776564434517
      }
    },
    {
      "id": "task-1776624109352-82",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "041e60e3-da91-40c1-bbf1-a5e22269521a"
      },
      "detectedAt": 1776562634406,
      "updatedAt": 1776562634406,
      "taskId": "041e60e3-da91-40c1-bbf1-a5e22269521a",
      "sourceType": "task",
      "sourceId": "041e60e3-da91-40c1-bbf1-a5e22269521a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "041e60e3-da91-40c1-bbf1-a5e22269521a",
        "failedAt": 1776562634406
      }
    },
    {
      "id": "task-1776624109352-83",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "c9c967d2-6042-4804-af49-f7275d11a26a"
      },
      "detectedAt": 1776562634402,
      "updatedAt": 1776562634402,
      "taskId": "c9c967d2-6042-4804-af49-f7275d11a26a",
      "sourceType": "task",
      "sourceId": "c9c967d2-6042-4804-af49-f7275d11a26a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "c9c967d2-6042-4804-af49-f7275d11a26a",
        "failedAt": 1776562634402
      }
    },
    {
      "id": "task-1776624109352-84",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "7dff96c5-c568-45f3-b2a6-761083d43d91"
      },
      "detectedAt": 1776562034576,
      "updatedAt": 1776562034576,
      "taskId": "7dff96c5-c568-45f3-b2a6-761083d43d91",
      "sourceType": "task",
      "sourceId": "7dff96c5-c568-45f3-b2a6-761083d43d91",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "7dff96c5-c568-45f3-b2a6-761083d43d91",
        "failedAt": 1776562034576
      }
    },
    {
      "id": "task-1776624109352-85",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "4065832f-f8ad-498b-b023-f01a03f8f7e7"
      },
      "detectedAt": 1776561972970,
      "updatedAt": 1776561972970,
      "taskId": "4065832f-f8ad-498b-b023-f01a03f8f7e7",
      "sourceType": "task",
      "sourceId": "4065832f-f8ad-498b-b023-f01a03f8f7e7",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "4065832f-f8ad-498b-b023-f01a03f8f7e7",
        "failedAt": 1776561972970
      }
    },
    {
      "id": "task-1776624109352-86",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow workflow-steward.workflow-gap-review",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e818735e-50d2-4956-9cff-ea49cd32c450"
      },
      "detectedAt": 1776561732113,
      "updatedAt": 1776561732113,
      "taskId": "e818735e-50d2-4956-9cff-ea49cd32c450",
      "sourceType": "task",
      "sourceId": "e818735e-50d2-4956-9cff-ea49cd32c450",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e818735e-50d2-4956-9cff-ea49cd32c450",
        "failedAt": 1776561732113
      }
    },
    {
      "id": "task-1776624109352-87",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "ce59c6d4-ba25-4e63-a618-a52005de2efe"
      },
      "detectedAt": 1776561552197,
      "updatedAt": 1776561552197,
      "taskId": "ce59c6d4-ba25-4e63-a618-a52005de2efe",
      "sourceType": "task",
      "sourceId": "ce59c6d4-ba25-4e63-a618-a52005de2efe",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "ce59c6d4-ba25-4e63-a618-a52005de2efe",
        "failedAt": 1776561552197
      }
    },
    {
      "id": "task-1776624109352-88",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "ad52ca5e-664b-4d3d-9a36-2bc1b1a13921"
      },
      "detectedAt": 1776561132159,
      "updatedAt": 1776561132159,
      "taskId": "ad52ca5e-664b-4d3d-9a36-2bc1b1a13921",
      "sourceType": "task",
      "sourceId": "ad52ca5e-664b-4d3d-9a36-2bc1b1a13921",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "ad52ca5e-664b-4d3d-9a36-2bc1b1a13921",
        "failedAt": 1776561132159
      }
    },
    {
      "id": "task-1776624109352-89",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "cce15533-339c-4274-85a4-9b7672ca2802"
      },
      "detectedAt": 1776557591681,
      "updatedAt": 1776557591681,
      "taskId": "cce15533-339c-4274-85a4-9b7672ca2802",
      "sourceType": "task",
      "sourceId": "cce15533-339c-4274-85a4-9b7672ca2802",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "cce15533-339c-4274-85a4-9b7672ca2802",
        "failedAt": 1776557591681
      }
    },
    {
      "id": "task-1776624109352-90",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "e52b6617-7c09-44ca-a276-61c0dbcbcf17"
      },
      "detectedAt": 1776557230888,
      "updatedAt": 1776557230888,
      "taskId": "e52b6617-7c09-44ca-a276-61c0dbcbcf17",
      "sourceType": "task",
      "sourceId": "e52b6617-7c09-44ca-a276-61c0dbcbcf17",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "e52b6617-7c09-44ca-a276-61c0dbcbcf17",
        "failedAt": 1776557230888
      }
    },
    {
      "id": "task-1776624109352-91",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "fdd702c0-e1c4-4cc4-8972-0e573701ecc4"
      },
      "detectedAt": 1776557230885,
      "updatedAt": 1776557230885,
      "taskId": "fdd702c0-e1c4-4cc4-8972-0e573701ecc4",
      "sourceType": "task",
      "sourceId": "fdd702c0-e1c4-4cc4-8972-0e573701ecc4",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "fdd702c0-e1c4-4cc4-8972-0e573701ecc4",
        "failedAt": 1776557230885
      }
    },
    {
      "id": "task-1776624109352-92",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "7032efeb-7ef4-4b37-8863-8a1829db5546"
      },
      "detectedAt": 1776556330811,
      "updatedAt": 1776556330811,
      "taskId": "7032efeb-7ef4-4b37-8863-8a1829db5546",
      "sourceType": "task",
      "sourceId": "7032efeb-7ef4-4b37-8863-8a1829db5546",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "7032efeb-7ef4-4b37-8863-8a1829db5546",
        "failedAt": 1776556330811
      }
    },
    {
      "id": "task-1776624109352-93",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "a2607771-c641-4436-86ad-1bd626580d14"
      },
      "detectedAt": 1776555730928,
      "updatedAt": 1776555730928,
      "taskId": "a2607771-c641-4436-86ad-1bd626580d14",
      "sourceType": "task",
      "sourceId": "a2607771-c641-4436-86ad-1bd626580d14",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "a2607771-c641-4436-86ad-1bd626580d14",
        "failedAt": 1776555730928
      }
    },
    {
      "id": "task-1776624109352-94",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "c65810ef-0831-4d75-b65d-11aaa8f41d05"
      },
      "detectedAt": 1776555430826,
      "updatedAt": 1776555430826,
      "taskId": "c65810ef-0831-4d75-b65d-11aaa8f41d05",
      "sourceType": "task",
      "sourceId": "c65810ef-0831-4d75-b65d-11aaa8f41d05",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "c65810ef-0831-4d75-b65d-11aaa8f41d05",
        "failedAt": 1776555430826
      }
    },
    {
      "id": "task-1776624109352-95",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "89b2fca0-d408-4dd3-8546-dd459acbc17f"
      },
      "detectedAt": 1776555190795,
      "updatedAt": 1776555190795,
      "taskId": "89b2fca0-d408-4dd3-8546-dd459acbc17f",
      "sourceType": "task",
      "sourceId": "89b2fca0-d408-4dd3-8546-dd459acbc17f",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "89b2fca0-d408-4dd3-8546-dd459acbc17f",
        "failedAt": 1776555190795
      }
    },
    {
      "id": "task-1776624109352-96",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "0a39cbe3-9f04-449d-abc9-5b9608c2d249"
      },
      "detectedAt": 1776553870717,
      "updatedAt": 1776553870717,
      "taskId": "0a39cbe3-9f04-449d-abc9-5b9608c2d249",
      "sourceType": "task",
      "sourceId": "0a39cbe3-9f04-449d-abc9-5b9608c2d249",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "0a39cbe3-9f04-449d-abc9-5b9608c2d249",
        "failedAt": 1776553870717
      }
    },
    {
      "id": "task-1776624109352-97",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "1e8e97ea-cdb5-4358-9d90-317e609a183f"
      },
      "detectedAt": 1776553630765,
      "updatedAt": 1776553630765,
      "taskId": "1e8e97ea-cdb5-4358-9d90-317e609a183f",
      "sourceType": "task",
      "sourceId": "1e8e97ea-cdb5-4358-9d90-317e609a183f",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "1e8e97ea-cdb5-4358-9d90-317e609a183f",
        "failedAt": 1776553630765
      }
    },
    {
      "id": "task-1776624109352-98",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "3e181e36-3a4b-4015-b954-51b4bdb16a4a"
      },
      "detectedAt": 1776553630763,
      "updatedAt": 1776553630763,
      "taskId": "3e181e36-3a4b-4015-b954-51b4bdb16a4a",
      "sourceType": "task",
      "sourceId": "3e181e36-3a4b-4015-b954-51b4bdb16a4a",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "3e181e36-3a4b-4015-b954-51b4bdb16a4a",
        "failedAt": 1776553630763
      }
    },
    {
      "id": "task-1776624109352-99",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "5b3028a1-c274-4eee-8b9c-0513adfbe4e4"
      },
      "detectedAt": 1776551831139,
      "updatedAt": 1776551831139,
      "taskId": "5b3028a1-c274-4eee-8b9c-0513adfbe4e4",
      "sourceType": "task",
      "sourceId": "5b3028a1-c274-4eee-8b9c-0513adfbe4e4",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "5b3028a1-c274-4eee-8b9c-0513adfbe4e4",
        "failedAt": 1776551831139
      }
    },
    {
      "id": "task-1776624109352-100",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "f9dccee0-f10b-4952-9034-51e2223a9e43"
      },
      "detectedAt": 1776551831136,
      "updatedAt": 1776551831136,
      "taskId": "f9dccee0-f10b-4952-9034-51e2223a9e43",
      "sourceType": "task",
      "sourceId": "f9dccee0-f10b-4952-9034-51e2223a9e43",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "f9dccee0-f10b-4952-9034-51e2223a9e43",
        "failedAt": 1776551831136
      }
    },
    {
      "id": "task-1776624109352-101",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "34d703a4-1889-4669-b6a2-e2800baed38c"
      },
      "detectedAt": 1776551228354,
      "updatedAt": 1776551228354,
      "taskId": "34d703a4-1889-4669-b6a2-e2800baed38c",
      "sourceType": "task",
      "sourceId": "34d703a4-1889-4669-b6a2-e2800baed38c",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "34d703a4-1889-4669-b6a2-e2800baed38c",
        "failedAt": 1776551228354
      }
    },
    {
      "id": "task-1776624109352-102",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "44ce55d0-4f5a-4209-a185-b45694f50e64"
      },
      "detectedAt": 1776550628373,
      "updatedAt": 1776550628373,
      "taskId": "44ce55d0-4f5a-4209-a185-b45694f50e64",
      "sourceType": "task",
      "sourceId": "44ce55d0-4f5a-4209-a185-b45694f50e64",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "44ce55d0-4f5a-4209-a185-b45694f50e64",
        "failedAt": 1776550628373
      }
    },
    {
      "id": "task-1776624109352-103",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "9e85a701-d090-4e12-b2af-c633ab83c934"
      },
      "detectedAt": 1776550148331,
      "updatedAt": 1776550148331,
      "taskId": "9e85a701-d090-4e12-b2af-c633ab83c934",
      "sourceType": "task",
      "sourceId": "9e85a701-d090-4e12-b2af-c633ab83c934",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "9e85a701-d090-4e12-b2af-c633ab83c934",
        "failedAt": 1776550148331
      }
    },
    {
      "id": "task-1776624109352-104",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "54cd619a-59d0-4b39-bf22-568d804c4c03"
      },
      "detectedAt": 1776550027940,
      "updatedAt": 1776550027940,
      "taskId": "54cd619a-59d0-4b39-bf22-568d804c4c03",
      "sourceType": "task",
      "sourceId": "54cd619a-59d0-4b39-bf22-568d804c4c03",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "54cd619a-59d0-4b39-bf22-568d804c4c03",
        "failedAt": 1776550027940
      }
    },
    {
      "id": "task-1776624109352-105",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "5e20221d-ced6-475e-a96e-9119380b6bfd"
      },
      "detectedAt": 1776549967977,
      "updatedAt": 1776549967977,
      "taskId": "5e20221d-ced6-475e-a96e-9119380b6bfd",
      "sourceType": "task",
      "sourceId": "5e20221d-ced6-475e-a96e-9119380b6bfd",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "5e20221d-ced6-475e-a96e-9119380b6bfd",
        "failedAt": 1776549967977
      }
    },
    {
      "id": "task-1776624109352-106",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "f6a451b6-28c9-4df4-b88d-af62a972b0e1"
      },
      "detectedAt": 1776546727215,
      "updatedAt": 1776546727215,
      "taskId": "f6a451b6-28c9-4df4-b88d-af62a972b0e1",
      "sourceType": "task",
      "sourceId": "f6a451b6-28c9-4df4-b88d-af62a972b0e1",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "f6a451b6-28c9-4df4-b88d-af62a972b0e1",
        "failedAt": 1776546727215
      }
    },
    {
      "id": "task-1776624109352-107",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "3be3738e-8864-4d86-a316-9a99d84eff2c"
      },
      "detectedAt": 1776546427274,
      "updatedAt": 1776546427274,
      "taskId": "3be3738e-8864-4d86-a316-9a99d84eff2c",
      "sourceType": "task",
      "sourceId": "3be3738e-8864-4d86-a316-9a99d84eff2c",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "3be3738e-8864-4d86-a316-9a99d84eff2c",
        "failedAt": 1776546427274
      }
    },
    {
      "id": "task-1776624109352-108",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "d14b4106-a5a0-4fc3-b9a1-50bd3758f3f6"
      },
      "detectedAt": 1776546307254,
      "updatedAt": 1776546307254,
      "taskId": "d14b4106-a5a0-4fc3-b9a1-50bd3758f3f6",
      "sourceType": "task",
      "sourceId": "d14b4106-a5a0-4fc3-b9a1-50bd3758f3f6",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "d14b4106-a5a0-4fc3-b9a1-50bd3758f3f6",
        "failedAt": 1776546307254
      }
    },
    {
      "id": "task-1776624109352-109",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "97edc9ab-091c-4dc6-8266-b79540f40ee1"
      },
      "detectedAt": 1776543316443,
      "updatedAt": 1776543316443,
      "taskId": "97edc9ab-091c-4dc6-8266-b79540f40ee1",
      "sourceType": "task",
      "sourceId": "97edc9ab-091c-4dc6-8266-b79540f40ee1",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "97edc9ab-091c-4dc6-8266-b79540f40ee1",
        "failedAt": 1776543316443
      }
    },
    {
      "id": "task-1776624109352-110",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "f4e9394f-2066-448b-b3b1-145955a07049"
      },
      "detectedAt": 1776542751772,
      "updatedAt": 1776542751772,
      "taskId": "f4e9394f-2066-448b-b3b1-145955a07049",
      "sourceType": "task",
      "sourceId": "f4e9394f-2066-448b-b3b1-145955a07049",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "f4e9394f-2066-448b-b3b1-145955a07049",
        "failedAt": 1776542751772
      }
    },
    {
      "id": "task-1776624109352-111",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "af8fcf1a-071b-49cd-ae03-0f412208c610"
      },
      "detectedAt": 1776542751770,
      "updatedAt": 1776542751770,
      "taskId": "af8fcf1a-071b-49cd-ae03-0f412208c610",
      "sourceType": "task",
      "sourceId": "af8fcf1a-071b-49cd-ae03-0f412208c610",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "af8fcf1a-071b-49cd-ae03-0f412208c610",
        "failedAt": 1776542751770
      }
    },
    {
      "id": "task-1776624109352-112",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "0836c411-b91d-422b-87fa-f3989adf9a54"
      },
      "detectedAt": 1776542751768,
      "updatedAt": 1776542751768,
      "taskId": "0836c411-b91d-422b-87fa-f3989adf9a54",
      "sourceType": "task",
      "sourceId": "0836c411-b91d-422b-87fa-f3989adf9a54",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "0836c411-b91d-422b-87fa-f3989adf9a54",
        "failedAt": 1776542751768
      }
    },
    {
      "id": "task-1776624109352-113",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "4971917c-946c-469a-a6c2-5a2ae8eaab4d"
      },
      "detectedAt": 1776542115987,
      "updatedAt": 1776542115987,
      "taskId": "4971917c-946c-469a-a6c2-5a2ae8eaab4d",
      "sourceType": "task",
      "sourceId": "4971917c-946c-469a-a6c2-5a2ae8eaab4d",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "4971917c-946c-469a-a6c2-5a2ae8eaab4d",
        "failedAt": 1776542115987
      }
    },
    {
      "id": "task-1776624109352-114",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "45534439-46ad-4ee0-b9ef-4c040b6ec2aa"
      },
      "detectedAt": 1776541540461,
      "updatedAt": 1776541540461,
      "taskId": "45534439-46ad-4ee0-b9ef-4c040b6ec2aa",
      "sourceType": "task",
      "sourceId": "45534439-46ad-4ee0-b9ef-4c040b6ec2aa",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "45534439-46ad-4ee0-b9ef-4c040b6ec2aa",
        "failedAt": 1776541540461
      }
    },
    {
      "id": "task-1776624109352-115",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "17c0e065-6dc0-4170-ab2b-8b2fef2bb330"
      },
      "detectedAt": 1776541036723,
      "updatedAt": 1776541036723,
      "taskId": "17c0e065-6dc0-4170-ab2b-8b2fef2bb330",
      "sourceType": "task",
      "sourceId": "17c0e065-6dc0-4170-ab2b-8b2fef2bb330",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "17c0e065-6dc0-4170-ab2b-8b2fef2bb330",
        "failedAt": 1776541036723
      }
    },
    {
      "id": "task-1776624109352-116",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "62a81393-6aa8-4ac3-a43d-09bb11d7b4e0"
      },
      "detectedAt": 1776540965387,
      "updatedAt": 1776540965387,
      "taskId": "62a81393-6aa8-4ac3-a43d-09bb11d7b4e0",
      "sourceType": "task",
      "sourceId": "62a81393-6aa8-4ac3-a43d-09bb11d7b4e0",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "62a81393-6aa8-4ac3-a43d-09bb11d7b4e0",
        "failedAt": 1776540965387
      }
    },
    {
      "id": "task-1776624109352-117",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "2bbf49c2-583f-43ae-9ce3-c40a3a927e34"
      },
      "detectedAt": 1776539771767,
      "updatedAt": 1776539771767,
      "taskId": "2bbf49c2-583f-43ae-9ce3-c40a3a927e34",
      "sourceType": "task",
      "sourceId": "2bbf49c2-583f-43ae-9ce3-c40a3a927e34",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "2bbf49c2-583f-43ae-9ce3-c40a3a927e34",
        "failedAt": 1776539771767
      }
    },
    {
      "id": "task-1776624109352-118",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "263daae1-8632-4c3b-a2a9-654951dbd099"
      },
      "detectedAt": 1776539289422,
      "updatedAt": 1776539289422,
      "taskId": "263daae1-8632-4c3b-a2a9-654951dbd099",
      "sourceType": "task",
      "sourceId": "263daae1-8632-4c3b-a2a9-654951dbd099",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "263daae1-8632-4c3b-a2a9-654951dbd099",
        "failedAt": 1776539289422
      }
    },
    {
      "id": "task-1776624109352-119",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "01b1daf2-8c54-46be-9fc0-e453432e5d1c"
      },
      "detectedAt": 1776539289421,
      "updatedAt": 1776539289421,
      "taskId": "01b1daf2-8c54-46be-9fc0-e453432e5d1c",
      "sourceType": "task",
      "sourceId": "01b1daf2-8c54-46be-9fc0-e453432e5d1c",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "01b1daf2-8c54-46be-9fc0-e453432e5d1c",
        "failedAt": 1776539289421
      }
    },
    {
      "id": "task-1776624109352-120",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "58e133e0-51f5-43bd-a77e-14362e1ef33e"
      },
      "detectedAt": 1776539122127,
      "updatedAt": 1776539122127,
      "taskId": "58e133e0-51f5-43bd-a77e-14362e1ef33e",
      "sourceType": "task",
      "sourceId": "58e133e0-51f5-43bd-a77e-14362e1ef33e",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "58e133e0-51f5-43bd-a77e-14362e1ef33e",
        "failedAt": 1776539122127
      }
    },
    {
      "id": "task-1776624109352-121",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "30be26fd-1410-4064-8dae-3b164b79f50c"
      },
      "detectedAt": 1776538416830,
      "updatedAt": 1776538416830,
      "taskId": "30be26fd-1410-4064-8dae-3b164b79f50c",
      "sourceType": "task",
      "sourceId": "30be26fd-1410-4064-8dae-3b164b79f50c",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "30be26fd-1410-4064-8dae-3b164b79f50c",
        "failedAt": 1776538416830
      }
    },
    {
      "id": "task-1776624109352-122",
      "projectId": "ui-dogfood-2026-04-18",
      "urgency": "watching",
      "actionability": "watching",
      "kind": "issue",
      "severity": "normal",
      "automationState": "blocked_for_agent",
      "category": "task",
      "title": "Task failed recently: Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep",
      "summary": "Task was cancelled or failed in the last 24 hours",
      "destination": "/tasks",
      "focusContext": {
        "taskId": "776ff12c-82de-42d9-ba90-e7a67ea030e4"
      },
      "detectedAt": 1776538416822,
      "updatedAt": 1776538416822,
      "taskId": "776ff12c-82de-42d9-ba90-e7a67ea030e4",
      "sourceType": "task",
      "sourceId": "776ff12c-82de-42d9-ba90-e7a67ea030e4",
      "recommendedAction": "Inspect the failure and decide whether to retry, re-scope, or close it out.",
      "metadata": {
        "taskId": "776ff12c-82de-42d9-ba90-e7a67ea030e4",
        "failedAt": 1776538416822
      }
    }
  ],
  "counts": {
    "actionNeeded": 0,
    "watching": 123,
    "fyi": 0
  },
  "generatedAt": 1776624109352
}
```

## Decisions
```json
{
  "projectId": "ui-dogfood-2026-04-18",
  "items": [],
  "counts": {
    "actionNeeded": 0,
    "watching": 0,
    "fyi": 0
  },
  "generatedAt": 1776624109760
}
```

## Running
```text
## Running State

Domain: enabled

Active Sessions: 0

Queue:
  dispatched     1
  failed         242
  cancelled      2

Active dispatches:
  [dispatched] 2026-04-19 18:40:59 "Run recurring workflow ui-dogfood-2026-0"

```

## Governed onboarding inventory
```text
jurisdiction_entities	proposed	bootstrapping
0		

(no rows)
```

## Onboarding state
```text
key	value	updated_at
last_digest_at	1776498008214	1776498008214
welcome_delivered	true	1776498008213
```

## Onboarding-related open tasks
```text
id	title	state	assigned_to	kind	entity_id	updated_at
8a70f01e-6b37-4a0c-988c-64b29befe34e	Investigate recurring workflow dispatches that lose their active session in ui-dogfood-2026-04-18	OPEN		infra		1776557070558
```

## Recurring failure count
```text
recurring_failures
70
```

## Standing infra task
```json
{
  "task": {
    "id": "8a70f01e-6b37-4a0c-988c-64b29befe34e",
    "projectId": "ui-dogfood-2026-04-18",
    "title": "Investigate recurring workflow dispatches that lose their active session in ui-dogfood-2026-04-18",
    "description": "Production-watch evidence from 2026-04-18 shows the monitoring loop itself is unreliable in this domain.\n\nObserved evidence:\n- production-watch failed at 22:07 and 23:07 UTC after exhausting dispatch retries\n- integrity-sweep and onboarding-backlog-sweep show the same pattern in the same window\n- running state at 00:01 UTC shows 0 active sessions with 3 queue items still marked dispatched\n- dispatch_queue errors repeatedly report \"Stale dispatched item: no active session after 11m\" followed by \"Recovered missed dispatch cron job after ~120s with no active session; exhausted dispatch retries\"\n\nWhy this matters:\n- The domain currently has no governed entities, so there is no live data drift to remediate yet.\n- But the production observation loop is not dependable, which is recent release fallout that can hide real correctness regressions once entities exist.\n\nAcceptance criteria:\n- Identify why dispatched recurring jobs in this domain end up with no active session while remaining in dispatched state\n- Prove whether the fault is in session launch, lease recovery, or dispatcher bookkeeping\n- Ship a structural fix or guarded fallback so recurring jobs either run successfully or fail with actionable ownership instead of silent no-session churn\n- Verify with evidence that production-watch, integrity-sweep, and onboarding-backlog-sweep each complete a fresh run without hitting the no-active-session retry pattern",
    "state": "OPEN",
    "priority": "P1",
    "createdBy": "ui-dogfood-2026-04-18-production-sentinel",
    "createdAt": 1776557070558,
    "updatedAt": 1776557070558,
    "retryCount": 0,
    "maxRetries": 3,
    "tags": [
      "production-watch",
      "dispatch",
      "release-fallout",
      "correctness-risk"
    ],
    "kind": "infra",
    "origin": "reactive",
    "metadata": {
      "surfacedBy": "production-watch",
      "surfacedAt": "2026-04-19T00:04:30.552Z",
      "domain": "ui-dogfood-2026-04-18"
    }
  },
  "evidence": [],
  "transitions": [],
  "reviews": [],
  "activeSessions": [],
  "recentSessions": [],
  "linkedIssue": null,
  "entityIssueSummary": null
}
```

## Recent errors
```text
## Errors (last 24h)

Dispatch failures:
  2026-04-19 18:21:56 "Run recurring workflow ui-dogfood-2026-0"
    Stale dispatched item: no active session after 19m (attempts: 1)
  2026-04-19 18:16:56 "Run recurring workflow ui-dogfood-2026-0"
    Agent "ui-dogfood-2026-04-18-source-onboarding-steward" rate limit reached (15/15 per hour) (attempts: 1)
  2026-04-19 18:07:57 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 18:01:56 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 18:01:56 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 17:56:56 "Run recurring workflow ui-dogfood-2026-0"
    Stale dispatched item: no active session after 11m (attempts: 1)
  2026-04-19 17:46:56 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 17:36:56 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 17:31:56 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 17:26:56 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 17:09:02 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 119s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 16:34:02 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 533s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 16:34:02 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 533s with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 15:58:14 "Run recurring workflow ui-dogfood-2026-0"
    Recovered stale dispatch cron job after 17m with no active session; exhausted dispatch retries (attempts: 3)
  2026-04-19 15:15:36 "Run recurring workflow ui-dogfood-2026-0"
    Recovered missed dispatch cron job after 1087s with no active session; exhausted dispatch retries (attempts: 3)

Failed tasks:
  2026-04-19 18:16:56  "Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep" (ui-dogfood-2026-04-18-source-onboarding-steward)
  2026-04-19 18:13:57  "Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep" (ui-dogfood-2026-04-18-source-onboarding-steward)
  2026-04-19 18:07:57  "Run recurring workflow ui-dogfood-2026-04-18-production-sentinel.production-watch" (ui-dogfood-2026-04-18-production-sentinel)
  2026-04-19 18:07:57  "Run recurring workflow ui-dogfood-2026-04-18-integrity-gatekeeper.integrity-sweep" (ui-dogfood-2026-04-18-integrity-gatekeeper)
  2026-04-19 17:52:57  "Run recurring workflow ui-dogfood-2026-04-18-source-onboarding-steward.onboarding-backlog-sweep" (ui-dogfood-2026-04-18-source-onboarding-steward)
```
