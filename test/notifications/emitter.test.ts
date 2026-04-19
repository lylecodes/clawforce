import type { DatabaseSync } from "../../src/sqlite-driver.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

const { getMemoryDb } = await import("../../src/db.js");
const { ensureNotificationTable, getNotificationByProject, listNotifications } = await import(
  "../../src/notifications/store.js"
);
const {
  emitNotification,
  setNotificationDeliveryAdapter,
  getNotificationDeliveryAdapter,
} = await import("../../src/notifications/emitter.js");

describe("notifications/emitter", () => {
  let db: DatabaseSync;
  const PROJECT = "emitter-test";

  beforeEach(() => {
    db = getMemoryDb();
    ensureNotificationTable(db);
    // Clear adapter between tests
    setNotificationDeliveryAdapter(null);
  });

  afterEach(() => {
    setNotificationDeliveryAdapter(null);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("emitNotification creates and returns a notification record", () => {
    const record = emitNotification(
      PROJECT,
      {
        category: "task",
        severity: "warning",
        actionability: "dismissible",
        title: "Task failed",
        body: "Build step failed.",
      },
      db,
    );

    expect(record.id).toBeDefined();
    expect(record.projectId).toBe(PROJECT);
    expect(record.category).toBe("task");
    expect(record.severity).toBe("warning");
    expect(record.title).toBe("Task failed");
    expect(record.read).toBe(false);
    expect(record.dismissed).toBe(false);
    expect(record.deliveryStatus).toBe("pending");

    // Verify it persisted to the DB
    const fetched = getNotificationByProject(PROJECT, record.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Task failed");
  });

  it("emitNotification persists to inbox even without a delivery adapter", () => {
    expect(getNotificationDeliveryAdapter()).toBeNull();

    emitNotification(
      PROJECT,
      {
        category: "system",
        severity: "critical",
        actionability: "action-required",
        title: "Kill switch",
        body: "Emergency stop activated.",
      },
      db,
    );

    const all = listNotifications(PROJECT, {}, db);
    expect(all.length).toBe(1);
    expect(all[0]!.title).toBe("Kill switch");
  });

  it("calls delivery adapter when set", async () => {
    const adapter = vi.fn().mockResolvedValue(undefined);
    setNotificationDeliveryAdapter(adapter);

    expect(getNotificationDeliveryAdapter()).toBe(adapter);

    emitNotification(
      PROJECT,
      {
        category: "approval",
        severity: "warning",
        actionability: "action-required",
        title: "Approval needed",
        body: "An agent is requesting approval.",
      },
      db,
    );

    // Wait for the async delivery to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(adapter).toHaveBeenCalledOnce();
    const calledWith = adapter.mock.calls[0]![0];
    expect(calledWith.title).toBe("Approval needed");
    expect(calledWith.category).toBe("approval");
  });

  it("records delivery failure but does not throw", async () => {
    const adapter = vi.fn().mockRejectedValue(new Error("Network error"));
    setNotificationDeliveryAdapter(adapter);

    const record = emitNotification(
      PROJECT,
      {
        category: "budget",
        severity: "critical",
        actionability: "action-required",
        title: "Budget exceeded",
        body: "Monthly budget exceeded.",
      },
      db,
    );

    // emitNotification should return synchronously without throwing
    expect(record.id).toBeDefined();

    // Wait for async delivery to fail and be recorded
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fetched = getNotificationByProject(PROJECT, record.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.deliveryStatus).toBe("failed");
    expect(fetched!.deliveryError).toContain("Network error");
  });

  it("records successful delivery status when adapter resolves", async () => {
    const adapter = vi.fn().mockResolvedValue(undefined);
    setNotificationDeliveryAdapter(adapter);

    const record = emitNotification(
      PROJECT,
      {
        category: "health",
        severity: "warning",
        actionability: "dismissible",
        title: "Health alert",
        body: "Latency is high.",
      },
      db,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const fetched = getNotificationByProject(PROJECT, record.id, db);
    expect(fetched!.deliveryStatus).toBe("delivered");
    expect(fetched!.deliveryError).toBeUndefined();
  });

  it("setNotificationDeliveryAdapter can clear the adapter with null", () => {
    const adapter = vi.fn();
    setNotificationDeliveryAdapter(adapter);
    expect(getNotificationDeliveryAdapter()).toBe(adapter);

    setNotificationDeliveryAdapter(null);
    expect(getNotificationDeliveryAdapter()).toBeNull();
  });

  it("emitNotification includes optional destination and focusContext", () => {
    const record = emitNotification(
      PROJECT,
      {
        category: "approval",
        severity: "warning",
        actionability: "action-required",
        title: "Approve deploy",
        body: "Review required.",
        destination: "/clawforce/approvals",
        focusContext: { proposalId: "p-42" },
      },
      db,
    );

    expect(record.destination).toBe("/clawforce/approvals");
    expect(record.focusContext).toEqual({ proposalId: "p-42" });

    const fetched = getNotificationByProject(PROJECT, record.id, db);
    expect(fetched!.focusContext).toEqual({ proposalId: "p-42" });
  });
});
