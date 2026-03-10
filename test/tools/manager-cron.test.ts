import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "mock-sig"),
  verifyAction: vi.fn(() => true),
  getAgentIdentity: vi.fn(() => ({ agentId: "a", hmacKey: "k", identityToken: "t", issuedAt: 0 })),
  resetIdentitiesForTest: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const dbModule = await import("../../src/db.js");
const { parseScheduleMs, parseSchedule, buildManagerCronJob, toCronJobCreate, buildJobCronJob } = await import("../../src/manager-cron.js");

describe("parseScheduleMs", () => {
  it("parses raw milliseconds", () => {
    expect(parseScheduleMs("300000")).toBe(300_000);
    expect(parseScheduleMs("1000")).toBe(1000);
  });

  it("parses every:N format", () => {
    expect(parseScheduleMs("every:300000")).toBe(300_000);
    expect(parseScheduleMs("every:60000")).toBe(60_000);
  });

  it("parses seconds shorthand", () => {
    expect(parseScheduleMs("30s")).toBe(30_000);
  });

  it("parses minutes shorthand", () => {
    expect(parseScheduleMs("5m")).toBe(300_000);
  });

  it("parses hours shorthand", () => {
    expect(parseScheduleMs("1h")).toBe(3_600_000);
  });

  it("parses days shorthand", () => {
    expect(parseScheduleMs("1d")).toBe(86_400_000);
  });

  it("returns default 300000 for invalid format", () => {
    expect(parseScheduleMs("invalid")).toBe(300_000);
    expect(parseScheduleMs("abc123")).toBe(300_000);
    expect(parseScheduleMs("")).toBe(300_000);
  });
});

describe("buildManagerCronJob", () => {
  it("builds a cron job with correct name and agentId", () => {
    const db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);

    const job = buildManagerCronJob("my-project", "leon", "5m");

    expect(job.name).toBe("manager-my-project");
    expect(job.agentId).toBe("leon");
    expect(job.schedule).toBe("5m");
    expect(job.payload).toContain("my-project");
    expect(job.payload).toContain("manager");

    vi.restoreAllMocks();
    db.close();
  });

  it("includes state hints when DB has tasks", async () => {
    const db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);

    // Insert an OPEN task
    const { createTask } = await import("../../src/tasks/ops.js");
    createTask({ projectId: "hint-project", title: "Open task", createdBy: "agent:a" }, db);

    const job = buildManagerCronJob("hint-project", "leon", "5m");
    expect(job.payload).toContain("OPEN task");

    vi.restoreAllMocks();
    db.close();
  });

  it("handles empty DB gracefully", () => {
    const db = getMemoryDb();
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);

    const job = buildManagerCronJob("empty-project", "leon", "5m");
    expect(job.payload).toContain("No active tasks");

    vi.restoreAllMocks();
    db.close();
  });
});

describe("toCronJobCreate", () => {
  it("converts ManagerCronJob to gateway format", () => {
    const job = {
      name: "manager-test",
      schedule: "5m",
      agentId: "leon",
      payload: "Review your context",
    };

    const result = toCronJobCreate(job);

    expect(result.name).toBe("manager-test");
    expect(result.agentId).toBe("leon");
    expect(result.enabled).toBe(true);
    expect(result.schedule).toEqual({ kind: "every", everyMs: 300_000 });
    expect(result.sessionTarget).toBe("isolated");
    expect(result.wakeMode).toBe("now");
    expect(result.payload).toEqual({ kind: "agentTurn", message: "Review your context" });
  });

  it("parses schedule string via parseScheduleMs", () => {
    const job = {
      name: "manager-test",
      schedule: "1h",
      agentId: "leon",
      payload: "nudge",
    };

    const result = toCronJobCreate(job);
    expect(result.schedule).toEqual({ kind: "every", everyMs: 3_600_000 });
  });

  it("converts cron expression schedule", () => {
    const job = {
      name: "manager-test",
      schedule: "0 9 * * MON-FRI",
      agentId: "leon",
      payload: "nudge",
    };

    const result = toCronJobCreate(job);
    expect(result.schedule).toEqual({ kind: "cron", expr: "0 9 * * MON-FRI" });
  });

  it("converts one-shot schedule with auto deleteAfterRun", () => {
    const job = {
      name: "one-shot",
      schedule: "at:2025-12-31T23:59:00Z",
      agentId: "leon",
      payload: "run once",
    };

    const result = toCronJobCreate(job);
    expect(result.schedule).toEqual({ kind: "at", at: "2025-12-31T23:59:00Z" });
    expect(result.deleteAfterRun).toBe(true);
  });

  it("passes through optional fields", () => {
    const job = {
      name: "rich-job",
      schedule: "5m",
      agentId: "leon",
      payload: "nudge",
      model: "claude-sonnet-4-20250514",
      timeoutSeconds: 300,
      lightContext: true,
      delivery: { mode: "announce" as const, channel: "engineering" },
      failureAlert: { after: 2, channel: "ops-alerts" },
    };

    const result = toCronJobCreate(job);
    expect(result.payload.model).toBe("claude-sonnet-4-20250514");
    expect(result.payload.timeoutSeconds).toBe(300);
    expect(result.payload.lightContext).toBe(true);
    expect(result.delivery).toEqual({ mode: "announce", channel: "engineering" });
    expect(result.failureAlert).toEqual({ after: 2, channel: "ops-alerts" });
  });
});

describe("buildJobCronJob", () => {
  it("builds a cron job with correct name format", () => {
    const job = buildJobCronJob("my-project", "leon", "triage", { cron: "5m" }, "5m");

    expect(job.name).toBe("job-my-project-leon-triage");
    expect(job.agentId).toBe("leon");
    expect(job.schedule).toBe("5m");
  });

  it("includes job tag in payload", () => {
    const job = buildJobCronJob("proj", "agent1", "dispatch", {}, "10m");

    expect(job.payload).toContain("[clawforce:job=dispatch]");
  });

  it("uses default nudge when job has no nudge", () => {
    const job = buildJobCronJob("proj", "agent1", "triage", {}, "5m");

    expect(job.payload).toContain('Review your context and complete the "triage" job.');
  });

  it("uses custom nudge when job specifies one", () => {
    const job = buildJobCronJob("proj", "agent1", "triage", {
      nudge: "Check escalations and assign tasks.",
    }, "5m");

    expect(job.payload).toContain("Check escalations and assign tasks.");
    expect(job.payload).not.toContain("Review your context");
  });

  it("payload starts with the job tag", () => {
    const job = buildJobCronJob("proj", "agent1", "dispatch", {}, "5m");

    expect(job.payload.startsWith("[clawforce:job=dispatch]")).toBe(true);
  });

  it("applies cronTimezone to cron expression schedules", () => {
    const job = buildJobCronJob("proj", "agent1", "report", {
      cronTimezone: "America/New_York",
    }, "0 9 * * MON-FRI");

    expect(job.schedule).toBe("cron:0 9 * * MON-FRI|America/New_York");
  });

  it("does not apply cronTimezone to interval schedules", () => {
    const job = buildJobCronJob("proj", "agent1", "report", {
      cronTimezone: "America/New_York",
    }, "5m");

    expect(job.schedule).toBe("5m");
  });

  it("passes through delivery and failureAlert", () => {
    const job = buildJobCronJob("proj", "agent1", "report", {
      delivery: { mode: "announce", channel: "eng" },
      failureAlert: { after: 3 },
      model: "claude-sonnet-4-20250514",
    }, "1h");

    expect(job.delivery).toEqual({ mode: "announce", channel: "eng" });
    expect(job.failureAlert).toEqual({ after: 3 });
    expect(job.model).toBe("claude-sonnet-4-20250514");
  });
});

describe("parseSchedule", () => {
  it("parses duration shorthand to interval", () => {
    expect(parseSchedule("5m")).toEqual({ kind: "every", everyMs: 300_000 });
    expect(parseSchedule("1h")).toEqual({ kind: "every", everyMs: 3_600_000 });
    expect(parseSchedule("30s")).toEqual({ kind: "every", everyMs: 30_000 });
    expect(parseSchedule("1d")).toEqual({ kind: "every", everyMs: 86_400_000 });
  });

  it("parses raw milliseconds to interval", () => {
    expect(parseSchedule("60000")).toEqual({ kind: "every", everyMs: 60_000 });
    expect(parseSchedule("300000")).toEqual({ kind: "every", everyMs: 300_000 });
  });

  it("parses every: prefix to interval", () => {
    expect(parseSchedule("every:300000")).toEqual({ kind: "every", everyMs: 300_000 });
  });

  it("parses cron expression (5 fields)", () => {
    expect(parseSchedule("0 9 * * MON-FRI")).toEqual({ kind: "cron", expr: "0 9 * * MON-FRI" });
    expect(parseSchedule("*/5 * * * *")).toEqual({ kind: "cron", expr: "*/5 * * * *" });
  });

  it("parses cron expression with 6th field as timezone", () => {
    expect(parseSchedule("0 9 * * MON-FRI America/New_York")).toEqual({
      kind: "cron", expr: "0 9 * * MON-FRI", tz: "America/New_York",
    });
  });

  it("parses cron: prefix", () => {
    expect(parseSchedule("cron:*/5 * * * *")).toEqual({ kind: "cron", expr: "*/5 * * * *" });
  });

  it("parses cron: prefix with pipe timezone", () => {
    expect(parseSchedule("cron:0 9 * * *|US/Pacific")).toEqual({
      kind: "cron", expr: "0 9 * * *", tz: "US/Pacific",
    });
  });

  it("parses at: prefix as one-shot", () => {
    expect(parseSchedule("at:2025-12-31T23:59:00Z")).toEqual({
      kind: "at", at: "2025-12-31T23:59:00Z",
    });
  });

  it("parses bare ISO datetime as one-shot", () => {
    expect(parseSchedule("2025-12-31T23:59:00Z")).toEqual({
      kind: "at", at: "2025-12-31T23:59:00Z",
    });
  });

  it("falls back to 5m interval for unrecognized", () => {
    expect(parseSchedule("invalid")).toEqual({ kind: "every", everyMs: 300_000 });
    expect(parseSchedule("abc")).toEqual({ kind: "every", everyMs: 300_000 });
  });
});
