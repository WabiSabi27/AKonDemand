import { useEffect, useReducer } from "react";

/**
 * React Query may preserve an identical meeting snapshot forever. Re-render
 * at its deadline so an elapsed meeting disappears even without a data change.
 */
export function useMeetingExpiry(meetingAt: string | null) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!meetingAt) return;
    const deadline = Date.parse(meetingAt);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        refresh();
      } else {
        // Longer delays overflow JS timers. Schedule another check instead.
        timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
      }
    };
    check();
    return () => clearTimeout(timer);
  }, [meetingAt]);
}
