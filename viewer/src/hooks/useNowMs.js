import { useEffect, useState } from 'react';

/** The current clock, refreshed every `intervalMs`, for text read at display time
 * (a saved check opened later must not show an estimate that already passed). */
export default function useNowMs(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
