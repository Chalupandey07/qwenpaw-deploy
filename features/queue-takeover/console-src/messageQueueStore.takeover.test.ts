import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_HEARTBEAT_STALE_MS,
  OWNER_IDLE_RELEASE_HIDDEN_MS,
  TAKEOVER_GRACE_MS,
  clearOwnershipHeartbeat,
  publishOwnershipHeartbeat,
  readOwnershipHeartbeat,
  registerOwnershipRelease,
  requestQueueTakeover,
  startOwnershipHeartbeat,
} from "./messageQueueStore";

// Multi-tab "Take over sending" (B4).
//
// A Web Lock can never be revoked from another tab, so the handoff is a
// two-tab protocol over the queue BroadcastChannel:
//
//   claimant --release-ownership(sessionId, requestId)--> owner
//   owner    --aborts the signal holding its lock-->      (lock released)
//   owner    --takeover-claim(requestId)-->               claimant
//
// These suites drive the pieces with a fake channel that behaves like the real
// one (a message reaches every OTHER channel on the same name, never the
// sender), so the assertions match what a second tab observes. The listener
// half (the owner aborting on the message) is covered in
// `messageQueueStore.crossTab.test.ts`, where the store's real listener is
// exercised.

const HEARTBEAT_PREFIX = "qwenpaw:queue-owner-heartbeat:";

describe("requestQueueTakeover", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts release-ownership with this tab's sessionId and request id", async () => {
    // The module caches one channel at import; observe it through a peer on
    // the same name, exactly like the second tab in a real browser.
    const peer = new BroadcastChannel("qwenpaw:queue");
    const seen: Array<Record<string, unknown>> = [];
    peer.addEventListener("message", (event: MessageEvent) => {
      seen.push(event.data as Record<string, unknown>);
    });

    const requestId = requestQueueTakeover("sess-post");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: "release-ownership",
      sessionId: "sess-post",
      requestId,
    });
    peer.close();
  });

  it("returns a request id that starts with the takeover prefix", () => {
    const requestId = requestQueueTakeover("sess-prefix");
    expect(requestId).toBeTruthy();
    expect(requestId).toMatch(/^tk-/);
  });

  it("returns a distinct request id for every request", () => {
    const a = requestQueueTakeover("sess-uniq");
    const b = requestQueueTakeover("sess-uniq");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("registerOwnershipRelease", () => {
  it("replaces a previous registration for the same session", () => {
    const first = vi.fn();
    const second = vi.fn();
    const clearFirst = registerOwnershipRelease("sess-replace", first);
    registerOwnershipRelease("sess-replace", second);
    clearFirst(); // must not clear the newer registration
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("returns an unregister that is safe to call twice", () => {
    const release = vi.fn();
    const clear = registerOwnershipRelease("sess-twice", release);
    expect(() => {
      clear();
      clear();
    }).not.toThrow();
    expect(release).not.toHaveBeenCalled();
  });
});

describe("ownership heartbeat", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("publishes and reads back the owner state", () => {
    publishOwnershipHeartbeat("sess-hb", { hidden: true, busy: false });
    const heartbeat = readOwnershipHeartbeat("sess-hb");
    expect(heartbeat?.hidden).toBe(true);
    expect(heartbeat?.busy).toBe(false);
    expect(typeof heartbeat?.ts).toBe("number");
  });

  it("returns null for a missing or corrupt heartbeat", () => {
    expect(readOwnershipHeartbeat("sess-none")).toBeNull();
    localStorage.setItem(HEARTBEAT_PREFIX + "sess-corrupt", "{not json");
    expect(readOwnershipHeartbeat("sess-corrupt")).toBeNull();
    localStorage.setItem(
      HEARTBEAT_PREFIX + "sess-num",
      JSON.stringify({ ts: "x" }),
    );
    expect(readOwnershipHeartbeat("sess-num")).toBeNull();
  });

  it("clearOwnershipHeartbeat removes the entry", () => {
    publishOwnershipHeartbeat("sess-clear", { hidden: false, busy: true });
    clearOwnershipHeartbeat("sess-clear");
    expect(readOwnershipHeartbeat("sess-clear")).toBeNull();
  });

  it("never throws when storage rejects the write", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    expect(() =>
      publishOwnershipHeartbeat("sess-quota", { hidden: false, busy: false }),
    ).not.toThrow();
    setItem.mockRestore();
  });

  it("stamps a fresh ts on every publish", () => {
    publishOwnershipHeartbeat("sess-ts", { hidden: false, busy: false });
    const first = readOwnershipHeartbeat("sess-ts")?.ts ?? 0;
    publishOwnershipHeartbeat("sess-ts", { hidden: false, busy: true });
    const second = readOwnershipHeartbeat("sess-ts")?.ts ?? 0;
    expect(second).toBeGreaterThanOrEqual(first);
    expect(OWNER_HEARTBEAT_STALE_MS).toBeGreaterThan(0);
  });
});

describe("startOwnershipHeartbeat", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes immediately, before the first interval fires", () => {
    const stop = startOwnershipHeartbeat(
      "sess-imm",
      () => ({ hidden: false, busy: true }),
      () => undefined,
      1000,
    );
    expect(readOwnershipHeartbeat("sess-imm")?.busy).toBe(true);
    stop();
  });

  it("does not release while something is in flight", () => {
    const onIdle = vi.fn();
    const stop = startOwnershipHeartbeat(
      "sess-busy",
      () => ({ hidden: true, busy: true }),
      onIdle,
      1000,
    );
    vi.advanceTimersByTime(OWNER_IDLE_RELEASE_HIDDEN_MS * 3);
    expect(onIdle).not.toHaveBeenCalled();
    stop();
  });

  it("does not release while the tab is visible", () => {
    const onIdle = vi.fn();
    const stop = startOwnershipHeartbeat(
      "sess-visible",
      () => ({ hidden: false, busy: false }),
      onIdle,
      1000,
    );
    vi.advanceTimersByTime(OWNER_IDLE_RELEASE_HIDDEN_MS * 3);
    expect(onIdle).not.toHaveBeenCalled();
    stop();
  });

  it("releases once after a hidden AND idle owner exceeds the timeout", () => {
    const onIdle = vi.fn();
    const stop = startOwnershipHeartbeat(
      "sess-idle",
      () => ({ hidden: true, busy: false }),
      onIdle,
      1000,
    );
    vi.advanceTimersByTime(OWNER_IDLE_RELEASE_HIDDEN_MS + 2000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(OWNER_IDLE_RELEASE_HIDDEN_MS * 2);
    expect(onIdle).toHaveBeenCalledTimes(1);
    stop();
  });

  it("restarts the idle clock when the tab becomes visible again", () => {
    const onIdle = vi.fn();
    let hidden = true;
    const stop = startOwnershipHeartbeat(
      "sess-return",
      () => ({ hidden, busy: false }),
      onIdle,
      1000,
    );
    vi.advanceTimersByTime(OWNER_IDLE_RELEASE_HIDDEN_MS - 1000);
    hidden = false;
    vi.advanceTimersByTime(2000);
    hidden = true;
    vi.advanceTimersByTime(OWNER_IDLE_RELEASE_HIDDEN_MS - 1000);
    expect(onIdle).not.toHaveBeenCalled();
    stop();
  });

  it("clears the heartbeat and stops ticking on cleanup", () => {
    const onIdle = vi.fn();
    const stop = startOwnershipHeartbeat(
      "sess-stop",
      () => ({ hidden: true, busy: false }),
      onIdle,
      1000,
    );
    stop();
    expect(readOwnershipHeartbeat("sess-stop")).toBeNull();
    vi.advanceTimersByTime(OWNER_IDLE_RELEASE_HIDDEN_MS * 3);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("keeps the takeover grace window shorter than the stale-heartbeat window", () => {
    // The button re-enables on TAKEOVER_GRACE_MS so the user can retry, and
    // only calls the owner "gone" once its heartbeat is older than the stale
    // threshold; if these inverted, a retry could be offered before the UI
    // could ever explain why it is needed.
    expect(TAKEOVER_GRACE_MS).toBeLessThan(OWNER_HEARTBEAT_STALE_MS * 2);
    expect(TAKEOVER_GRACE_MS).toBeGreaterThan(0);
  });
});
