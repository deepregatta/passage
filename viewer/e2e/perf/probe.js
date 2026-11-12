// The in-page probe of the responsiveness measurement. A plain script (no imports), so that
// it runs both as a Playwright init script (scan-responsiveness.perf.js) and pasted into the
// DevTools console of a phone's Chrome (see docs/maintenance/2026-11-12-scan-responsiveness.md).
// It watches the page; it changes nothing in the app. Served by `npm run perf:serve` as /probe.js.
//
//   __perfSeed(meta, passageId)  write a planner draft for a passage (compute mode, invented boat, both ends set)
//   __perfArm(key, needle)       the next click starts the timing of `key`; it ends when `needle` shows in the page
//   __perfSummary(key)           the numbers for that action (see the record for what each means)
(() => {
  if (window.__perf) return;
  const P = (window.__perf = { longtasks: [], events: [], frames: 0, frameGaps: [], texts: [], taps: [], clickAt: {}, resultAt: {}, watch: {}, armed: null, alert: null, lags: [] });
  const round = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
  // the status line under each action button (not the map hint, which is absolutely positioned)
  const statusText = () => [...document.querySelectorAll('p[aria-live="polite"]:not(.absolute)')].map((p) => p.textContent.trim()).filter(Boolean).join(' | ');
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longtasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  } catch { /* longtask unsupported: the frame gaps and the lag sampler remain */ }
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) P.events.push([e.name, e.startTime, e.processingStart - e.startTime, e.duration]); }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch { /* event timing unsupported */ }
  let lastFrame = null;
  let lastText = '';
  const frame = (t) => {
    P.frames += 1;
    if (lastFrame !== null && t - lastFrame > 50) P.frameGaps.push([lastFrame, t - lastFrame]);
    lastFrame = t;
    const text = statusText();
    if (text !== lastText) { P.texts.push([t, text]); lastText = text; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // a timer-lag sampler as a cross-check on the long-task entries (which only report tasks over 50 ms)
  let expected = performance.now() + 10;
  setInterval(() => { const now = performance.now(); if (now - expected > 30) P.lags.push([now, now - expected]); expected = now + 10; }, 10);
  document.addEventListener('click', (e) => {
    if (P.armed) { P.clickAt[P.armed] = { t: performance.now(), stamp: e.timeStamp, frames: P.frames }; P.armed = null; }
  }, true);
  document.addEventListener('pointerdown', (e) => { P.taps.push([e.timeStamp, performance.now()]); }, true);
  // result detection: the DOM commit, then the next frame as the paint
  const check = () => {
    for (const [key, needle] of Object.entries(P.watch)) {
      if (P.clickAt[key] && !P.resultAt[key] && document.body.textContent.includes(needle)) {
        P.resultAt[key] = { dom: performance.now(), frames: P.frames, paint: null };
        requestAnimationFrame(() => { P.resultAt[key].paint = performance.now(); });
      }
    }
    const alert = document.querySelector('[role="alert"]');
    if (alert && !P.alert) P.alert = alert.textContent;
  };
  const start = () => {
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
    // a corner pad outside the app: a tap on it can never reach the planner, so it cannot change the draft
    const pad = document.createElement('div');
    pad.id = 'perf-tap-pad';
    pad.style.cssText = 'position:fixed;right:0;bottom:0;width:56px;height:56px;z-index:2147483647;background:rgba(0,0,0,0.02)';
    document.documentElement.appendChild(pad);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  window.__perfArm = (key, needle) => { P.watch[key] = needle; P.armed = key; };

  /** One action's numbers. t0 = the click, t1 = the painted result. */
  window.__perfSummary = (key) => {
    const click = P.clickAt[key];
    const result = P.resultAt[key];
    if (!click || !result) return null;
    const t0 = click.t;
    const t1 = result.paint ?? result.dom;
    const inWindow = (start) => start >= t0 - 1 && start <= t1;
    const tasks = P.longtasks.filter(([start]) => inWindow(start));
    const durations = tasks.map(([, d]) => d);
    const gaps = P.frameGaps.filter(([start]) => inWindow(start));
    const texts = P.texts.filter(([t]) => t >= t0 && t <= t1);
    const lags = P.lags.filter(([t]) => t >= t0 && t <= t1).map(([, lag]) => lag);
    // Chrome stamps CDP-injected touches at dispatch, so a tap's delay comes from Event Timing (processingStart - startTime,
    // reported only when the event took 16 ms or more); taps handled at once are not listed there.
    const tapsSent = P.taps.filter(([, handled]) => handled >= t0 && handled <= t1).length;
    const tapDelays = P.events.filter(([name, start]) => name === 'pointerdown' && inWindow(start)).map(([, , delay]) => delay);
    const events = P.events.filter(([, start]) => inWindow(start));
    const longest = tasks.reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
    const inLongest = texts.filter(([t]) => t > longest[0] && t < longest[0] + longest[1]).length;
    const firstText = texts.find(([, text]) => text.length > 0);
    return {
      totalMs: round(t1 - t0),
      longTasks: { count: tasks.length, longestMs: round(Math.max(0, ...durations)), sumMs: round(durations.reduce((a, b) => a + b, 0)),
        over100: durations.filter((d) => d > 100).length, over1000: durations.filter((d) => d > 1000).length,
        largest: tasks.map(([start, d]) => [round(start - t0), round(d)]).sort((a, b) => b[1] - a[1]).slice(0, 4) },
      maxTimerLagMs: round(Math.max(0, ...lags)),
      firstProgressFrameMs: firstText ? round(firstText[0] - t0) : null,
      firstProgressText: firstText ? firstText[1] : null,
      progressTextChanges: texts.length,
      progressChangesDuringLongestBlock: inLongest,
      frames: result.frames - click.frames,
      longestFrameGapMs: round(Math.max(0, ...gaps.map(([, g]) => g))),
      frameGapsOver1000: gaps.filter(([, g]) => g > 1000).length,
      taps: { handledDuringRun: tapsSent, delayed16msOrMore: tapDelays.length, maxDelayMs: round(Math.max(0, ...tapDelays)), delaysMs: tapDelays.map((d) => round(d)) },
      slowClicks: events.filter(([name]) => name === 'click').map(([name, , delay, dur]) => [name, round(delay), round(dur)]).slice(0, 5),
      progressTimeline: texts.slice(0, 14).map(([t, text]) => [round(t - t0), text]),
    };
  };

  /** The planner draft of a passage, as the sailor would have left it: compute mode, the invented boat, both ends placed. */
  window.__perfSeed = (meta, passageId) => {
    const passage = meta.passages.find((p) => p.id === passageId);
    if (!passage) throw new Error(`unknown passage ${passageId}`);
    const d = new Date(meta.departureIso);
    const pad = (n) => String(n).padStart(2, '0');
    const departureLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const draft = {
      state: {
        mode: 'compute', polarId: meta.polarId, polarLabel: meta.polarLabel, polarPercent: 100, name: 'Perf passage', nameAuto: false,
        endpoints: [{ lat: passage.start.lat, lng: passage.start.lon }, { lat: passage.finish.lat, lng: passage.finish.lon }],
        departureLocal, waypoints: [], computed: null,
      },
      version: 3,
    };
    try { localStorage.setItem('deepweather.planner-draft', JSON.stringify(draft)); } catch { /* storage blocked */ }
    return draft;
  };
})();
