import { useEffect } from 'react';
import { usePlayback } from '../stores/playbackStore.js';
import { fmtLocalTime, localTimeZoneName } from '../lib/format.js';

export default function TimeRuler({ findings, maxHours }) {
  const cursor = usePlayback((state) => state.cursorHours);
  const playing = usePlayback((state) => state.playing);
  const setCursor = usePlayback((state) => state.setCursor);
  const play = usePlayback((state) => state.play);
  const pause = usePlayback((state) => state.pause);
  useEffect(() => () => pause(), [pause]);
  const time = new Date(Date.parse(findings.departure_utc) + cursor * 3600_000).toISOString();
  return <div className="grid grid-cols-[44px_1fr_auto] gap-2 items-center border-t border-ink/30 pt-2">
    <button type="button" onClick={() => playing ? pause() : play(maxHours)} className="w-11 h-11 border border-ink/40" aria-label={playing ? 'Pause passage playback' : 'Play passage playback'}>{playing ? 'Ⅱ' : '▶'}</button>
    <div><input aria-label="Passage time" type="range" min="0" max={maxHours} step="3" value={Math.round(cursor * 10) / 10} onChange={(event) => setCursor(Number(event.target.value))} className="w-full accent-event"/><div className="flex justify-between font-mono text-[9px] text-ink-soft"><span>departure</span><span>+{Math.round(cursor)} h</span><span>arrival</span></div></div>
    <output className="text-right whitespace-nowrap">
      <span className="block font-mono text-[11px]">{fmtLocalTime(time)}</span>
      <span className="block text-[9px] text-ink-soft"><span>local time</span> · {localTimeZoneName()}</span>
    </output>
  </div>;
}
