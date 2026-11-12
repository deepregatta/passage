import { EmulatedStamp } from '../../components/common.jsx';
import { currentModelFamily } from '../../lib/sourceNames.js';

// Fixed sentences for a prepared grid's resolution note, which is English free
// text from the factory and is never shown as it is.
const CAVEATS = {
  subsampled: 'This currents grid is coarser than the model’s native resolution.',
  coarse: 'The grid of this currents model is coarser than Passage aims for.',
};

/**
 * Under a computed route: the current model the route was computed on, named
 * by its family as the passage page's current block names it ("Model not
 * recorded" when no record identifies one), then the routing notes
 * (including "Currents unavailable…" when the route used wind alone).
 */
export default function RouteSourceNotes({ computed }) {
  const currents = computed?.currents;
  const notes = computed?.notes ?? [];
  return (
    <>
      {currents && (
        <p className="text-[12px] text-ink-soft" data-testid="route-currents">
          <span>Currents</span> · <span>{currentModelFamily(currents.model)?.name ?? 'Model not recorded'}</span>
          {currents.emulated && <> <EmulatedStamp /></>}
          {currents.caveat && CAVEATS[currents.caveat] && <span className="block">{CAVEATS[currents.caveat]}</span>}
        </p>
      )}
      {notes.length > 0 && <p className="text-[12px] text-ink-soft">{notes.join(' ')}</p>}
    </>
  );
}
