import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  getDb: vi.fn(() => ({ kind: "db" })),
}));

vi.mock("../../../src/notifications/store.js", () => ({
  getNotificationByProject: vi.fn(() => ({ id: "notif-1" })),
  markAllRead: vi.fn(() => 3),
  markDismissed: vi.fn(() => true),
  markRead: vi.fn(() => true),
}));

const {
  runDismissNotificationCommand,
  runMarkAllNotificationsReadCommand,
  runMarkNotificationReadCommand,
} = await import("../../../src/app/commands/notification-controls.js");
const { getDb } = await import("../../../src/db.js");
const {
  getNotificationByProject,
  markAllRead,
  markDismissed,
  markRead,
} = await import("../../../src/notifications/store.js");

describe("notification-controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks all notifications as read for a project", () => {
    const result = runMarkAllNotificationsReadCommand("domain-1");

    expect(getDb).toHaveBeenCalledWith("domain-1");
    expect(markAllRead).toHaveBeenCalled();
    expect(result).toEqual({
      status: 200,
      body: { ok: true, marked: 3 },
    });
  });

  it("marks a notification as read when it exists", () => {
    const result = runMarkNotificationReadCommand("domain-1", "notif-1");

    expect(getNotificationByProject).toHaveBeenCalled();
    expect(markRead).toHaveBeenCalledWith("notif-1", expect.anything());
    expect(result).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("returns 404 when marking read for a missing notification", () => {
    vi.mocked(getNotificationByProject).mockReturnValueOnce(null);

    const result = runMarkNotificationReadCommand("domain-1", "missing");

    expect(markRead).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 404,
      body: { error: "Notification not found" },
    });
  });

  it("dismisses a notification when it exists", () => {
    const result = runDismissNotificationCommand("domain-1", "notif-1");

    expect(getNotificationByProject).toHaveBeenCalled();
    expect(markDismissed).toHaveBeenCalledWith("notif-1", expect.anything());
    expect(result).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("returns 404 when dismissing a missing notification", () => {
    vi.mocked(getNotificationByProject).mockReturnValueOnce(null);

    const result = runDismissNotificationCommand("domain-1", "missing");

    expect(markDismissed).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 404,
      body: { error: "Notification not found" },
    });
  });
});
