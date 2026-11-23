import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import { Hand as HandIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  OWNER_HEARTBEAT_STALE_MS,
  TAKEOVER_GRACE_MS,
  readOwnershipHeartbeat,
  requestQueueTakeover,
} from "../../../stores/messageQueueStore";

type TakeoverPhase = "idle" | "requested" | "stalled" | "unsupported";

export interface TakeOverSendingButtonProps {
  /** The queue key the ownership lock is keyed by (`qwenpaw:queue-owner:{key}`). */
  queueSessionId: string;
  /**
   * Called once ownership has moved to this tab. The caller releases its own
   * queued `holdOwnershipLock` request; nothing here mutates the lock itself.
   */
  onTakenOver?: () => void;
  className?: string;
}

/**
 * "Take over sending" — rendered inside the queue-only banner, i.e. only in a
 * tab that is resolved as a non-owner.
 *
 * A Web Lock cannot be revoked from another tab, so this is a handoff request:
 * `requestQueueTakeover` broadcasts `release-ownership` on the same
 * `qwenpaw:queue` channel the queue already synchronises over, the owner aborts
 * the signal that holds its lock, and this tab's already-queued
 * `holdOwnershipLock` request is granted next.
 *
 * The button always reaches a terminal state so it can never look stuck:
 *  - the banner disappears once this tab becomes the owner (the parent
 *    component unmounts it), which is the success signal;
 *  - after `TAKEOVER_GRACE_MS` it shows "Still waiting…" and re-enables so the
 *    user can retry (the old owner may be suspended — a backgrounded tab's
 *    timers stop firing, so a retry after it wakes is the normal recovery);
 *  - when BroadcastChannel is unavailable the request cannot be delivered at
 *    all and it says so instead of pretending.
 */
export function TakeOverSendingButton({
  queueSessionId,
  onTakenOver,
  className,
}: TakeOverSendingButtonProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<TakeoverPhase>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // A stale heartbeat means the owner tab is gone or frozen. Say so, because
  // the takeover will then succeed only once that tab is closed or wakes.
  const ownerHeartbeat = readOwnershipHeartbeat(queueSessionId);
  const ownerLooksGone =
    phase === "stalled" &&
    (ownerHeartbeat === null ||
      Date.now() - ownerHeartbeat.ts > OWNER_HEARTBEAT_STALE_MS);

  const handleClick = useCallback(() => {
    const requestId = requestQueueTakeover(queueSessionId);
    if (!requestId) {
      setPhase("unsupported");
      return;
    }
    setPhase("requested");
    onTakenOver?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setPhase("stalled"), TAKEOVER_GRACE_MS);
  }, [onTakenOver, queueSessionId]);

  if (phase === "unsupported") {
    return (
      <Tooltip title={t("chat.queue.takeoverUnsupportedHint")}>
        <Button size="small" disabled className={className}>
          {t("chat.queue.takeoverUnsupported")}
        </Button>
      </Tooltip>
    );
  }

  const label =
    phase === "idle"
      ? t("chat.queue.takeOverSending")
      : phase === "requested"
        ? t("chat.queue.takeoverRequested")
        : ownerLooksGone
          ? t("chat.queue.takeoverOwnerGone")
          : t("chat.queue.takeoverStillWaiting");

  return (
    <Button
      size="small"
      type={phase === "idle" ? "primary" : "default"}
      icon={phase === "idle" ? <HandIcon size={14} /> : undefined}
      loading={phase === "requested"}
      className={className}
      onClick={handleClick}
      // Keep the label on one line: the banner is narrow in the composer.
      style={{ whiteSpace: "nowrap", flexShrink: 0 }}
    >
      {label}
    </Button>
  );
}
