import { useEffect, useRef } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

export type SleepWatchdogOptions = {
  /** Called when the app is detected to have come back after a gap in activity. */
  onResume: () => void;
  /** How often to record a heartbeat, in milliseconds. */
  heartbeatMs?: number;
  /** A heartbeat gap larger than this is treated as sleep, lock, or display-off. */
  resumeThresholdMs?: number;
};

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_RESUME_THRESHOLD_MS = 30_000;

/**
 * Detects display-off / host sleep even when no wake-up event is delivered:
 * timers are frozen while the host sleeps, so a heartbeat gap over the
 * threshold reliably means the app only just became active again.
 */
export function useSleepWatchdog({
  onResume,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  resumeThresholdMs = DEFAULT_RESUME_THRESHOLD_MS,
}: SleepWatchdogOptions) {
  const lastHeartbeatRef = useRef(Date.now());
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  useEffect(() => {
    let disposed = false;
    let unlistenFocus: (() => void) | undefined;

    const checkResume = () => {
      if (disposed) {
        return;
      }
      const now = Date.now();
      const gap = now - lastHeartbeatRef.current;
      lastHeartbeatRef.current = now;
      if (gap >= resumeThresholdMs) {
        onResumeRef.current();
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkResume();
      }
    };

    const timer = window.setInterval(checkResume, heartbeatMs);
    window.addEventListener('focus', checkResume);
    window.addEventListener('pageshow', checkResume);
    window.addEventListener('online', checkResume);
    document.addEventListener('visibilitychange', handleVisibility);

    if ('__TAURI_INTERNALS__' in window) {
      getCurrentWebviewWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused) {
            checkResume();
          }
        })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlistenFocus = unlisten;
          }
        })
        .catch(() => {
          // The timer and visibility events already cover wake-ups when the
          // native focus listener is unavailable.
        });
    }

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', checkResume);
      window.removeEventListener('pageshow', checkResume);
      window.removeEventListener('online', checkResume);
      document.removeEventListener('visibilitychange', handleVisibility);
      unlistenFocus?.();
    };
  }, [heartbeatMs, resumeThresholdMs]);
}
