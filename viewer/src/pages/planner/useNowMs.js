import { useEffect, useState } from 'react';

/**
 * The clock for a line that states an age: the injected `nowMs` when a caller
 * gives one (tests, a page that already holds a clock), otherwise the real time,
 * refreshed every minute so an open page does not keep an old age.
 * @param {number | undefined} injected
 */
export default function useNowMs(injected) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (injected !== undefined) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [injected]);
  return injected ?? now;
}
