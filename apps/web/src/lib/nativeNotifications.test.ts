import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  canShowNativeNotification,
  getNotificationPermission,
  requestNotificationPermission,
  resolveAttentionNotification,
  resolveTurnCompletionNotification,
  showNativeNotification,
  type NotifiableThread,
} from "./nativeNotifications";

type TestWindow = Window & typeof globalThis & { desktopBridge?: unknown; nativeApi?: unknown };

const SESSION_DEFAULTS = {
  orchestrationStatus: "ready",
  activeTurnId: null,
  lastError: null,
} as const;

function getTestWindow(): TestWindow {
  const testGlobal = globalThis as typeof globalThis & { window?: TestWindow };
  if (!testGlobal.window) {
    testGlobal.window = {} as TestWindow;
  }
  return testGlobal.window;
}

function createNotificationMock() {
  const constructorSpy = vi.fn();
  class MockNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = vi.fn(async () => "default" as NotificationPermission);

    constructor(title: string, options?: NotificationOptions) {
      constructorSpy({ title, options });
    }
  }
  return { MockNotification, constructorSpy };
}

function fakeThread(
  overrides: Omit<Partial<NotifiableThread>, "session"> & {
    session?: Record<string, unknown> | null;
  } = {},
): NotifiableThread {
  const { session: sessionOverrides, ...rest } = overrides;
  return {
    id: "thread-1",
    title: "My thread",
    activities: [],
    ...rest,
    session:
      sessionOverrides === null
        ? null
        : ({
            ...SESSION_DEFAULTS,
            ...sessionOverrides,
          } as NotifiableThread["session"]),
  };
}

function fakeActivity(
  overrides: Partial<OrchestrationThreadActivity>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "task.progress",
    summary: "Doing work",
    payload: null,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  const win = getTestWindow();
  delete win.desktopBridge;
  delete win.nativeApi;
});

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe("native notification permissions", () => {
  it("returns unsupported when Notification is unavailable", () => {
    delete (globalThis as { Notification?: unknown }).Notification;

    expect(getNotificationPermission()).toBe("unsupported");
  });

  it("requests permission when Notification is available", async () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.requestPermission = vi.fn(async () => "granted");
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    await expect(requestNotificationPermission()).resolves.toBe("granted");
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("requires browser permission outside desktop context", () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.permission = "denied";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    expect(canShowNativeNotification()).toBe(false);
    MockNotification.permission = "granted";
    expect(canShowNativeNotification()).toBe(true);
  });

  it("allows desktop context when the Notification constructor exists", () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.permission = "denied";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (getTestWindow() as unknown as { desktopBridge?: unknown }).desktopBridge = {};

    expect(canShowNativeNotification()).toBe(true);
  });

  it("shows a notification when allowed", () => {
    const { MockNotification, constructorSpy } = createNotificationMock();
    MockNotification.permission = "granted";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    expect(showNativeNotification({ title: "Test", body: "Hello", tag: "tag-1" })).toBe(true);
    expect(constructorSpy).toHaveBeenCalledWith({
      title: "Test",
      options: { body: "Hello", tag: "tag-1" },
    });
  });
});

describe("resolveTurnCompletionNotification", () => {
  const previous = { status: "running" as const, activeTurnId: "turn-1" };

  it("returns a completion notification at normal level", () => {
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: "normal",
      thread: fakeThread(),
      previous,
      lastNotifiedTurnId: undefined,
    });

    expect(result).toMatchObject({
      title: "Task completed",
      body: "My thread",
      turnId: "turn-1",
    });
  });

  it("suppresses successful completion at important level", () => {
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: "important",
      thread: fakeThread(),
      previous,
      lastNotifiedTurnId: undefined,
    });

    expect(result).toBeNull();
  });

  it("returns a failure notification at important level", () => {
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: "important",
      thread: fakeThread({
        session: { orchestrationStatus: "error", activeTurnId: null, lastError: "boom" },
      }),
      previous,
      lastNotifiedTurnId: undefined,
    });

    expect(result).toMatchObject({
      title: "Task failed",
      body: "boom",
      turnId: "turn-1",
    });
  });

  it("skips an already notified turn", () => {
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: "normal",
      thread: fakeThread(),
      previous,
      lastNotifiedTurnId: "turn-1",
    });

    expect(result).toBeNull();
  });
});

describe("resolveAttentionNotification", () => {
  it("fires for approval requested at important level", () => {
    const result = resolveAttentionNotification({
      shouldNotify: true,
      level: "important",
      thread: fakeThread({
        activities: [
          fakeActivity({
            id: EventId.make("activity-approval"),
            kind: "approval.requested",
            summary: "Approve command",
          }),
        ],
      }),
      lastNotifiedActivityId: undefined,
    });

    expect(result).toMatchObject({
      title: "Approval required",
      body: "Approve command",
      activityId: "activity-approval",
    });
  });

  it("ignores task progress below verbose level", () => {
    const result = resolveAttentionNotification({
      shouldNotify: true,
      level: "normal",
      thread: fakeThread({
        activities: [fakeActivity({ kind: "task.progress", summary: "Working" })],
      }),
      lastNotifiedActivityId: undefined,
    });

    expect(result).toBeNull();
  });

  it("fires for task progress at verbose level", () => {
    const result = resolveAttentionNotification({
      shouldNotify: true,
      level: "verbose",
      thread: fakeThread({
        activities: [fakeActivity({ kind: "task.progress", summary: "Working" })],
      }),
      lastNotifiedActivityId: undefined,
    });

    expect(result).toMatchObject({
      title: "Task update",
      body: "Working",
      activityId: "activity-1",
    });
  });
});
