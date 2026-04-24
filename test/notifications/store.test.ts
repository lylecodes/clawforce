import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { getMemoryDb } = await import("../../src/db.js");
const {
  createNotification,
  dismissRecurringWorkflowFailureNotifications,
  getNotificationByProject,
  getOperatorUnreadCount,
  listNotifications,
  listOperatorNotifications,
  markRead,
  markDismissed,
  markAllRead,
  markRecurringWorkflowFailureNotificationsRead,
  getUnreadCount,
  cleanupOldNotifications,
  ensureNotificationTable,
  RECURRING_WORKFLOW_FAILURE_NOTIFICATION_ID,
} = await import("../../src/notifications/store.js");

describe("notifications/store", () => {
  let db: DatabaseSync;
  const PROJECT = "notif-test";

  beforeEach(() => {
    db = getMemoryDb();
    ensureNotificationTable(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("creates a notification and retrieves it by project + id", () => {
    const notif = createNotification(
      PROJECT,
      {
        category: "task",
        severity: "warning",
        actionability: "dismissible",
        title: "Task failed",
        body: "The build task failed.",
      },
      db,
    );

    expect(notif.id).toBeDefined();
    expect(notif.projectId).toBe(PROJECT);
    expect(notif.category).toBe("task");
    expect(notif.severity).toBe("warning");
    expect(notif.actionability).toBe("dismissible");
    expect(notif.title).toBe("Task failed");
    expect(notif.body).toBe("The build task failed.");
    expect(notif.read).toBe(false);
    expect(notif.dismissed).toBe(false);
    expect(notif.deliveryStatus).toBe("pending");
    expect(notif.createdAt).toBeGreaterThan(0);

    const fetched = getNotificationByProject(PROJECT, notif.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(notif.id);
    expect(fetched!.title).toBe("Task failed");
  });

  it("creates a notification with optional fields", () => {
    const notif = createNotification(
      PROJECT,
      {
        category: "approval",
        severity: "critical",
        actionability: "action-required",
        title: "Approval needed",
        body: "Agent wants to deploy.",
        destination: "/clawforce/approvals",
        focusContext: { proposalId: "p-1" },
        deliveryChannel: "dashboard",
      },
      db,
    );

    expect(notif.destination).toBe("/clawforce/approvals");
    expect(notif.focusContext).toEqual({ proposalId: "p-1" });
    expect(notif.deliveryChannel).toBe("dashboard");

    const fetched = getNotificationByProject(PROJECT, notif.id, db);
    expect(fetched!.focusContext).toEqual({ proposalId: "p-1" });
    expect(fetched!.destination).toBe("/clawforce/approvals");
  });

  it("returns null for unknown notification id", () => {
    const result = getNotificationByProject(PROJECT, "non-existent-id", db);
    expect(result).toBeNull();
  });

  it("lists notifications for a project", () => {
    createNotification(
      PROJECT,
      { category: "task", severity: "warning", actionability: "dismissible", title: "T1", body: "B1" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "budget", severity: "critical", actionability: "action-required", title: "T2", body: "B2" },
      db,
    );

    const all = listNotifications(PROJECT, {}, db);
    expect(all.length).toBe(2);
  });

  it("filters by category", () => {
    createNotification(
      PROJECT,
      { category: "task", severity: "warning", actionability: "dismissible", title: "T1", body: "B1" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "budget", severity: "critical", actionability: "action-required", title: "T2", body: "B2" },
      db,
    );

    const tasks = listNotifications(PROJECT, { category: "task" }, db);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.category).toBe("task");
  });

  it("filters by severity", () => {
    createNotification(
      PROJECT,
      { category: "task", severity: "warning", actionability: "dismissible", title: "T1", body: "B1" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "budget", severity: "critical", actionability: "action-required", title: "T2", body: "B2" },
      db,
    );

    const critical = listNotifications(PROJECT, { severity: "critical" }, db);
    expect(critical.length).toBe(1);
    expect(critical[0]!.severity).toBe("critical");
  });

  it("filters by read status", () => {
    const n1 = createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "T1", body: "B1" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "T2", body: "B2" },
      db,
    );

    markRead(n1.id, db);

    const unread = listNotifications(PROJECT, { read: false }, db);
    expect(unread.length).toBe(1);
    expect(unread[0]!.title).toBe("T2");

    const readList = listNotifications(PROJECT, { read: true }, db);
    expect(readList.length).toBe(1);
    expect(readList[0]!.title).toBe("T1");
  });

  it("marks a notification as read", () => {
    const notif = createNotification(
      PROJECT,
      { category: "system", severity: "critical", actionability: "action-required", title: "Kill switch", body: "Activated." },
      db,
    );

    expect(notif.read).toBe(false);

    const changed = markRead(notif.id, db);
    expect(changed).toBe(true);

    const fetched = getNotificationByProject(PROJECT, notif.id, db);
    expect(fetched!.read).toBe(true);
    expect(fetched!.readAt).toBeGreaterThan(0);
  });

  it("returns false when marking an already-read notification", () => {
    const notif = createNotification(
      PROJECT,
      { category: "system", severity: "info", actionability: "informational", title: "Info", body: "FYI." },
      db,
    );

    markRead(notif.id, db);
    const changedAgain = markRead(notif.id, db);
    expect(changedAgain).toBe(false);
  });

  it("marks a notification as dismissed", () => {
    const notif = createNotification(
      PROJECT,
      { category: "health", severity: "warning", actionability: "dismissible", title: "Health alert", body: "Latency high." },
      db,
    );

    const changed = markDismissed(notif.id, db);
    expect(changed).toBe(true);

    const fetched = getNotificationByProject(PROJECT, notif.id, db);
    expect(fetched!.dismissed).toBe(true);
    expect(fetched!.dismissedAt).toBeGreaterThan(0);
  });

  it("marks all notifications as read for a project", () => {
    createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "T1", body: "B1" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "T2", body: "B2" },
      db,
    );

    const count = markAllRead(PROJECT, db);
    expect(count).toBe(2);

    const unread = listNotifications(PROJECT, { read: false }, db);
    expect(unread.length).toBe(0);
  });

  it("returns correct unread count", () => {
    const n1 = createNotification(
      PROJECT,
      { category: "task", severity: "warning", actionability: "dismissible", title: "T1", body: "B1" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "task", severity: "warning", actionability: "dismissible", title: "T2", body: "B2" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "task", severity: "warning", actionability: "dismissible", title: "T3", body: "B3" },
      db,
    );

    expect(getUnreadCount(PROJECT, db)).toBe(3);

    markRead(n1.id, db);
    expect(getUnreadCount(PROJECT, db)).toBe(2);

    markAllRead(PROJECT, db);
    expect(getUnreadCount(PROJECT, db)).toBe(0);
  });

  it("dismissed notifications are excluded from unread count", () => {
    const n1 = createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "T1", body: "B1" },
      db,
    );
    createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "T2", body: "B2" },
      db,
    );

    markDismissed(n1.id, db);
    // Dismissed but not read — unread count should exclude dismissed
    expect(getUnreadCount(PROJECT, db)).toBe(1);
  });

  it("cleans up old dismissed notifications", () => {
    // Create a notification with a fake old timestamp
    createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "Old", body: "Old dismissed." },
      db,
    );

    // Get its ID and mark it dismissed, then manually backdate it
    const all = listNotifications(PROJECT, {}, db);
    const oldNotif = all[0]!;

    markDismissed(oldNotif.id, db);

    // Manually backdate to 40 days ago
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(fortyDaysAgo, oldNotif.id);

    // Add a recent dismissed notification
    const recent = createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "Recent", body: "Recent dismissed." },
      db,
    );
    markDismissed(recent.id, db);

    const pruned = cleanupOldNotifications(PROJECT, 30, db);
    expect(pruned).toBe(1);

    const remaining = listNotifications(PROJECT, {}, db);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.title).toBe("Recent");
  });

  it("limits results with limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      createNotification(
        PROJECT,
        { category: "task", severity: "info", actionability: "informational", title: `T${i}`, body: `B${i}` },
        db,
      );
    }

    const page1 = listNotifications(PROJECT, { limit: 3, offset: 0 }, db);
    expect(page1.length).toBe(3);

    const page2 = listNotifications(PROJECT, { limit: 3, offset: 3 }, db);
    expect(page2.length).toBe(2);
  });

  it("does not return notifications for other projects", () => {
    createNotification(
      PROJECT,
      { category: "task", severity: "info", actionability: "informational", title: "Mine", body: "Mine." },
      db,
    );
    createNotification(
      "other-project",
      { category: "task", severity: "info", actionability: "informational", title: "Theirs", body: "Theirs." },
      db,
    );

    const mine = listNotifications(PROJECT, {}, db);
    expect(mine.length).toBe(1);
    expect(mine[0]!.title).toBe("Mine");
  });

  describe("operator inbox aggregation", () => {
    function createMinimalTasksTable() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          assigned_to TEXT,
          metadata TEXT
        )
      `);
      db.prepare("DELETE FROM tasks WHERE project_id = ?").run(PROJECT);
    }

    function insertRecurringTask(id: string, agentId: string, jobName: string) {
      db.prepare(
        "INSERT INTO tasks (id, project_id, title, assigned_to, created_by, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        PROJECT,
        `Run recurring workflow ${agentId}.${jobName}`,
        agentId,
        "test",
        Date.now(),
        Date.now(),
        JSON.stringify({
          recurringJob: {
            agentId,
            jobName,
            schedule: "*/5 * * * *",
          },
        }),
      );
    }

    function insertRegularTask(id: string) {
      db.prepare(
        "INSERT INTO tasks (id, project_id, title, assigned_to, created_by, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, PROJECT, "Non-recurring failure", "worker", "test", Date.now(), Date.now(), JSON.stringify({}));
    }

    function createTaskFailureNotification(taskId: string, title = "Task failed") {
      return createNotification(
        PROJECT,
        {
          category: "task",
          severity: "warning",
          actionability: "dismissible",
          title: `Task failed: ${title}`,
          body: "Task failed.",
          destination: "/clawforce/tasks",
          focusContext: { taskId },
        },
        db,
      );
    }

    it("groups recurring workflow failures in the operator inbox", () => {
      createMinimalTasksTable();
      insertRecurringTask("r1", "agent-a", "sweep");
      insertRecurringTask("r2", "agent-a", "sweep");
      insertRecurringTask("r3", "agent-b", "watch");
      insertRegularTask("n1");

      createTaskFailureNotification("r1", "recurring one");
      createTaskFailureNotification("r2", "recurring two");
      createTaskFailureNotification("r3", "recurring three");
      createTaskFailureNotification("n1", "ordinary failure");

      const raw = listNotifications(PROJECT, {}, db);
      expect(raw).toHaveLength(4);

      const operatorInbox = listOperatorNotifications(PROJECT, {}, db);
      expect(operatorInbox).toHaveLength(2);

      const aggregate = operatorInbox.find((n) => n.id === RECURRING_WORKFLOW_FAILURE_NOTIFICATION_ID);
      expect(aggregate).toBeDefined();
      expect(aggregate!.title).toBe("Recurring workflows failed recently: 2 jobs, 3 runs");
      expect(aggregate!.destination).toBe("/clawforce/ops");
      expect(aggregate!.focusContext).toMatchObject({
        notificationGroup: RECURRING_WORKFLOW_FAILURE_NOTIFICATION_ID,
        failedRunCount: "3",
        affectedJobCount: "2",
      });
      expect(operatorInbox.some((n) => n.focusContext?.taskId === "n1")).toBe(true);
      expect(getUnreadCount(PROJECT, db)).toBe(4);
      expect(getOperatorUnreadCount(PROJECT, db)).toBe(2);
    });

    it("marks and dismisses grouped recurring workflow failures through the synthetic id", () => {
      createMinimalTasksTable();
      insertRecurringTask("r1", "agent-a", "sweep");
      insertRecurringTask("r2", "agent-a", "sweep");
      insertRegularTask("n1");
      createTaskFailureNotification("r1", "recurring one");
      createTaskFailureNotification("r2", "recurring two");
      createTaskFailureNotification("n1", "ordinary failure");

      expect(markRecurringWorkflowFailureNotificationsRead(PROJECT, db)).toBe(2);
      expect(getUnreadCount(PROJECT, db)).toBe(1);
      expect(getOperatorUnreadCount(PROJECT, db)).toBe(1);

      expect(dismissRecurringWorkflowFailureNotifications(PROJECT, db)).toBe(2);
      const operatorInbox = listOperatorNotifications(PROJECT, { dismissed: false }, db);
      expect(operatorInbox).toHaveLength(1);
      expect(operatorInbox[0]!.focusContext?.taskId).toBe("n1");
    });
  });
});
