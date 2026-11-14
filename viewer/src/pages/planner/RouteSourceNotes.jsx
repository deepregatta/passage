import { EmulatedStamp } from '../../components/common.jsx';
import { currentsFetchedLine, isPreparedGrid } from '../../lib/currentsAge.js';
import { currentModelFamily } from '../../lib/sourceNames.js';
import useNowMs from './useNowMs.js';

// Fixed sentences for a prepared grid's resolution note, which is English free
// text from the factory and is never shown as it is.
const CAVEATS = {
  subsampled: 'This currents grid is coarser than the model’s native resolution.',
  coarse: 'The grid of this currents model is coarser than Passage aims for.',
};

/** A route the engine confined to the prepared current grid's box says so (it records the area it searched). */
const CONFINED_NOTE = 'Routed inside the area the regional current model covers; the route could not go outside it.';

/**
 * When the prepared regional current grid was fetched and how long ago; an old
 * one reads as a caution in the planner's notice style. Nothing without a
 * readable fetch time.
 */
function CurrentsFetched({ fetchedAt, nowMs }) {
  const line = currentsFetchedLine(fetchedAt, useNowMs(nowMs));
  if (!line) return null;
  return line.stale
    ? <p className="text-[13px] border-l-2 border-ink/50 pl-2" data-testid="route-currents-age" data-stale={line.stale}>{line.text}</p>
    : <p className="text-[12px] text-ink-soft" data-testid="route-currents-age" data-stale={line.stale}>{line.text}</p>;
}

/**
 * Under a computed route: the current model the route was computed on, named
 * by its family as the passage page's current block names it ("Model not
 * recorded" when no record identifies one), whether the route was confined to
 * that model's area, then the routing notes (including "Currents unavailable…"
 * when the route used wind alone). A route on the prepared regional grid also
 * states when that grid was fetched (`nowMs` stands in for the clock in tests).
 */
export default function RouteSourceNotes({ computed, nowMs }) {
  const currents = computed?.currents;
  const notes = computed?.notes ?? [];
  const confined = Boolean(computed?.route?.provenance?.routing_request?.search_bounds);
  return (
    <>
      {currents && (
        <p className="text-[12px] text-ink-soft" data-testid="route-currents">
          <span>Currents</span> · <span>{currentModelFamily(currents.model)?.name ?? 'Model not recorded'}</span>
          {currents.emulated && <> <EmulatedStamp /></>}
          {currents.caveat && CAVEATS[currents.caveat] && <span className="block">{CAVEATS[currents.caveat]}</span>}
        </p>
      )}
      {isPreparedGrid(currents) && <CurrentsFetched fetchedAt={currents.fetchedAt} nowMs={nowMs} />}
      {confined && <p className="text-[12px] text-ink-soft" data-testid="route-confined">{CONFINED_NOTE}</p>}
      {notes.length > 0 && <p className="text-[12px] text-ink-soft">{notes.join(' ')}</p>}
    </>
  );
}
