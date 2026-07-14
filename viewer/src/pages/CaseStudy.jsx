import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { fmtTime } from '../lib/format.js';

export default function CaseStudy() {
  const findings = useApp((state) => state.findings);
  const french = useApp((state) => state.language) === 'fr';
  const [doc, setDoc] = useState(null);
  useEffect(() => {
    if (!findings) return;
    fetch(`/data/verification/cases/${findings.snapshot_id}.json`).then((response) => response.ok ? response.json() : null).then(setDoc).catch(() => setDoc(null));
  }, [findings]);
  if (!findings) return <div className="p-8 font-instrument text-ink-soft">{french ? 'Ouvrez un briefing pour consulter son étude de cas.' : 'Open a briefing to view its case study.'}</div>;
  return <article className="max-w-5xl mx-auto px-4 sm:px-8 py-8 print:p-0">
    <header className="border-y-2 border-ink py-5 grid sm:grid-cols-[1fr_auto] gap-4">
      <div><p className="eyebrow">{french ? 'Cas de vérification publié · briefing figé' : 'Published verification case · frozen snapshot'}</p><h1 className="font-story text-4xl">{french ? 'Ce que prévoyait la météo et ce qui s’est produit' : 'What the forecast said, and what happened'}</h1><p className="font-mono text-[10px] mt-2">{findings.snapshot_id}</p></div>
      <button type="button" onClick={() => window.print()} className="print:hidden self-start min-h-11 px-4 border border-ink font-instrument">{french ? 'Imprimer / enregistrer en PDF' : 'Print / save PDF'}</button>
    </header>
    {!doc ? <section className="py-10 border-b hairline"><h2 className="font-story text-2xl">{french ? 'Observations pas encore jointes' : 'Observations not attached yet'}</h2><p className="font-instrument text-ink-soft mt-2">{french ? 'La prévision initiale reste figée. Ce rapport sera complété après la classification des observations.' : 'The original forecast remains frozen. This report will populate only after observations are classified.'}</p></section> : <>
      <section className="py-6 border-b hairline"><div className={doc.observation_source === 'emulated' ? 'stamp-emulated inline-block' : 'font-mono text-xs text-verdict-within'}>{doc.observation_source === 'emulated' ? (french ? 'DÉMONSTRATION SIMULÉE · AUCUN RÉSULTAT RÉEL' : 'EMULATED DEMO · NOT A SKILL CLAIM') : `${french ? 'SOURCE DES OBSERVATIONS' : 'OBSERVATION SOURCE'} · ${doc.observation_source}`}</div><p className="font-story text-2xl mt-3">{french ? 'La prévision sur la route a saisi l’évolution de l’événement. Le tableau consigne ses erreurs de chronologie et d’intensité sans réécriture a posteriori.' : 'The route forecast caught the event direction. The table records its timing and magnitude errors without hindsight edits.'}</p></section>
      <section className="py-6"><h2 className="font-instrument uppercase tracking-wider font-semibold">{french ? 'Décomposition de l’erreur' : 'Error decomposition'}</h2><div className="overflow-x-auto mt-3"><table className="w-full text-sm"><thead><tr className="border-b border-ink text-left"><th className="py-2">{french ? 'tronçon · heure UTC' : 'leg · valid UTC'}</th><th>{french ? 'variable' : 'variable'}</th><th>{french ? 'prévision figée' : 'frozen forecast'}</th><th>{french ? 'observation ultérieure' : 'later observation'}</th><th>{french ? 'erreur' : 'error'}</th><th>{french ? 'interprétation' : 'interpretation'}</th></tr></thead><tbody>{(doc.pairs ?? []).map((pair, index) => <tr key={index} className="border-b hairline"><td className="py-2 font-mono text-xs">{pair.leg_id} · {fmtTime(pair.valid_time)}</td><td>{pair.variable}</td><td className="font-mono">{pair.forecast}</td><td className="font-mono">{pair.observed}</td><td className="font-mono">{pair.error > 0 ? '+' : ''}{pair.error}</td><td>{Math.abs(pair.error) <= 2 ? (french ? 'intensité utile' : 'useful magnitude') : (french ? 'écart significatif, marge à élargir' : 'material miss; widen margin')}</td></tr>)}</tbody></table></div></section>
      <section className="grid sm:grid-cols-2 gap-6 border-t border-ink py-6"><div><p className="eyebrow">{french ? 'Interprétation initiale' : 'Original interpretation'}</p><p className="font-story text-xl mt-2">{findings.causal_events?.[0]?.consequence.register_plain ?? (french ? 'L’analyse initiale ne permettait pas d’attribuer les conditions à un système météo.' : 'Causal attribution was unavailable in the original run.')}</p></div><div><p className="eyebrow">{french ? 'Leçon pour la prochaine traversée' : 'Lesson for the next passage'}</p><p className="font-story text-xl mt-2">{french ? 'Traitez la chronologie de l’événement comme une fenêtre. Conservez votre limite personnelle, puis ajoutez l’erreur mesurée comme marge.' : 'Treat event timing as a window. Keep your personal limit, then add the measured forecast error as margin.'}</p></div></section>
    </>}
  </article>;
}
