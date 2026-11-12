import clsx from 'clsx';
import { OWNED } from '../lib/passages.js';
import { groupSummary, isByArrangement } from '../lib/dataSources.js';

// Licences and credit lines are register data, copied as recorded and never
// translated. OWNED keeps the localiser off them; the attribute is also used here
// for register data, not only for BriefingMessage text. Source names and providers
// go through the localiser (the French catalogue maps each descriptive name;
// proper names pass through), as do the labels and status words below.
// A redistribute value with no entry here (unconfirmed) is shown as not yet confirmed.
const REDISTRIBUTION = { yes: 'Yes, under the licence', no: 'No' };
// An arrangement is not a licence, so a yes there says so instead.
const BY_ARRANGEMENT = 'Yes, by arrangement with the provider';

function redistributionAnswer(source) {
  const answer = REDISTRIBUTION[source.redistribute];
  return answer === REDISTRIBUTION.yes && isByArrangement(source) ? BY_ARRANGEMENT : answer;
}

function Row({ label, pending, children }) {
  return (
    <div className="sm:grid sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-x-3">
      <dt className="font-sans text-ink-soft">{label}</dt>
      <dd className={clsx('min-w-0 [overflow-wrap:anywhere]', pending && 'text-ink-soft')}>{children}</dd>
    </div>
  );
}

/** One closed-by-default group of source cards. The native details/summary keeps
 * keyboard and screen-reader behaviour; the summary is a 44 px touch target and
 * says how many sources the group holds and how many are not yet confirmed. */
export function SourceGroup({ title, sources }) {
  return (
    <details className="group border-b hairline">
      <summary className="min-h-11 py-2.5 cursor-pointer font-sans text-[13px] font-medium">
        {groupSummary(title, sources)}
      </summary>
      <SourceTerms sources={sources} />
    </details>
  );
}

/** One card per source: licence, credit line, whether it may be passed on and
 * when its terms were read. A missing value says so; it never reads as permission. */
function SourceTerms({ sources }) {
  return (
    <ul className="grid md:grid-cols-2 gap-x-8">
      {sources.map((source) => (
        <li key={source.id} data-source-id={source.id} className="min-w-0 py-2 border-b hairline">
          <p className="font-sans text-[13px] font-medium [overflow-wrap:anywhere]">{source.name}</p>
          <p className="font-sans text-[12px] text-ink-soft [overflow-wrap:anywhere]">{source.provider}</p>
          <dl className="mt-1 space-y-0.5 font-sans text-[13px]">
            <Row label="Licence" pending={!source.licence}>
              {/* The arrangement wording is Passage's own, so the localiser translates it; other licences are verbatim data. */}
              {source.licence ? <span {...(isByArrangement(source) ? {} : OWNED)}>{source.licence}</span> : 'Not yet confirmed'}
            </Row>
            <Row label="Attribution" pending={!source.attribution}>
              {source.attribution ? <span {...OWNED}>{source.attribution}</span> : 'Not yet confirmed'}
            </Row>
            <Row label="Redistribution" pending={!REDISTRIBUTION[source.redistribute]}>
              {redistributionAnswer(source) ?? 'Not yet confirmed'}
            </Row>
            {source.share_alike === true && (
              <Row label="Share-alike">Yes, adapted data keep the same licence</Row>
            )}
            <Row label="Verified on" pending={!source.verified_on}>
              {source.verified_on ? <time dateTime={source.verified_on}>{source.verified_on}</time> : 'Not yet verified'}
            </Row>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export default SourceTerms;
