import { useEffect, useState } from 'react';
import { useApp } from '../stores/appStore.js';
import { Panel, EmulatedStamp } from '../components/common.jsx';
import { fmtTime } from '../lib/format.js';

const CLASS_LABEL = {
  verified_near_observation: 'verified near observation',
  partially_observed: 'partially observed',
  reanalysis_referenced: 'reanalysis-referenced',
  not_independently_observed: 'not independently observed',
  emulated: 'emulated observations',
};

async function loadJson(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

export default function Verification() {
  const findings = useApp((s) => s.findings);
  const language = useApp((s) => s.language);
  const french = language === 'fr';
  const [caseDoc, setCaseDoc] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [caseIndex, setCaseIndex] = useState(null);
  const [corpus, setCorpus] = useState(null);

  useEffect(() => {
    Promise.all([
      loadJson('/data/verification/calibration.json').then(setCalibration),
      loadJson('/data/verification/cases/index.json').then(setCaseIndex),
      loadJson('/data/verification/corpus.json').then(setCorpus),
    ]);
  }, []);
  useEffect(() => {
    if (!findings) return;
    if (!caseIndex) return;
    const exists = caseIndex.cases?.some((item) => (item.snapshot_id ?? item) === findings.snapshot_id);
    if (!exists) return setCaseDoc(null);
    loadJson(`/data/verification/cases/${findings.snapshot_id}.json`).then(setCaseDoc);
  }, [findings, caseIndex]);

  return (
    <div className="px-6 py-5 max-w-5xl space-y-4">
      <header>
        <h1 className="font-chart text-3xl">{french ? 'Bilan de fiabilité' : 'Track record'}</h1>
        <p className="font-sans text-sm text-ink-soft mt-1 max-w-2xl">
          {french
            ? 'Comparez les prévisions de vos briefings avec les conditions réellement observées. Chaque résultat indique la taille de son échantillon et le degré d’indépendance des observations.'
            : 'How the forecasts in your briefings compared with what actually happened. This is the page where Passage earns your trust. Every number carries its sample size and how independent the observation really was.'}
        </p>
      </header>

      <div className="border-y border-ink/40 py-3 flex flex-wrap gap-x-6 gap-y-2 font-instrument text-sm">
        <strong>
          {french
            ? `Les mesures de fiabilité reposent sur ${corpus?.cases ?? 0} cas ERA5 réels.`
            : `Skill claims use ${corpus?.cases ?? 0} real ERA5 cases.`}
        </strong>
        <span>
          {corpus
            ? french
              ? `${corpus.pass} ${corpus.pass === 1 ? 'réussite' : 'réussites'} · ${corpus.fail} ${corpus.fail === 1 ? 'échec' : 'échecs'} · ${corpus.pending} en attente`
              : `${corpus.pass} pass · ${corpus.fail} fail · ${corpus.pending} pending`
            : french ? 'Résumé du corpus indisponible.' : 'Corpus summary unavailable.'}
        </span>
        <span>{emulatedCaseLabel(caseIndex, french)}</span>
      </div>

      <Panel title={findings ? `${french ? 'Cette analyse' : 'This analysis'} · ${findings.snapshot_id}` : french ? 'Cette analyse' : 'This analysis'}>
        {!findings && <p className="font-sans text-sm text-ink-soft">{french ? 'Ouvrez d’abord un briefing.' : 'Open a snapshot first.'}</p>}
        {findings && !caseDoc && (
          <p className="font-sans text-sm text-ink-soft">
            {french
              ? 'Pas encore vérifiée. Une fois la traversée terminée, cette prévision figée sera comparée aux observations disponibles.'
              : 'Not verified yet. After the passage window, the verification job will match this frozen forecast against later observations.'}
          </p>
        )}
        {caseDoc && (
          <>
            <div className="flex flex-wrap gap-2 mb-3">
              {Object.entries(caseDoc.coverage_summary ?? {}).map(([klass, count]) => (
                <span
                  key={klass}
                  className="font-sans text-[12px] border hairline rounded-sm px-2 py-0.5 flex items-center gap-1.5"
                >
                  {klass === 'emulated' ? <EmulatedStamp /> : coverageLabel(klass, french)}
                  <span className="font-mono">{count}</span>
                </span>
              ))}
            </div>
            <table className="w-full font-sans text-[13px]">
              <thead>
                <tr className="text-left border-b hairline">
                  <th className="eyebrow py-1">{french ? 'tronçon · heure' : 'leg · hour'}</th>
                  <th className="eyebrow">variable</th>
                  <th className="eyebrow">{french ? 'prévision' : 'forecast'}</th>
                  <th className="eyebrow">{french ? 'observation' : 'observed'}</th>
                  <th className="eyebrow">{french ? 'écart' : 'error'}</th>
                </tr>
              </thead>
              <tbody>
                {(caseDoc.pairs ?? []).slice(0, 24).map((p, i) => (
                  <tr key={i} className="border-b hairline last:border-0">
                    <td className="py-1 font-mono text-[12px]">
                      {p.leg_id} · {fmtTime(p.valid_time)}
                    </td>
                    <td>{p.variable}</td>
                    <td className="font-mono">{p.forecast}</td>
                    <td className="font-mono">{p.observed}</td>
                    <td className="font-mono">
                      {p.error > 0 ? '+' : ''}
                      {p.error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      <Panel title={french ? 'Historique d’étalonnage' : 'Calibration record'}>
        {!calibration && (
          <p className="font-sans text-sm text-ink-soft">
            {french
              ? 'Aucune donnée d’étalonnage pour le moment. Les analyses vérifiées construiront cet historique. Les observations simulées restent signalées et ne comptent jamais comme résultats réels.'
              : 'No calibration data yet. Verified analyses will build this record over time. Emulated observations stay labeled and never count as real skill.'}
          </p>
        )}
        {calibration && (
          <table className="w-full font-sans text-[13px]">
            <thead>
              <tr className="text-left border-b hairline">
                <th className="eyebrow py-1">variable</th>
                <th className="eyebrow">{french ? 'échéance' : 'lead'}</th>
                <th className="eyebrow">{french ? 'zone' : 'area'}</th>
                <th className="eyebrow">n</th>
                <th className="eyebrow">{french ? 'biais' : 'bias'}</th>
                <th className="eyebrow">{french ? 'dispersion' : 'spread'}</th>
                <th className="eyebrow">{french ? 'couverture' : 'coverage'}</th>
              </tr>
            </thead>
            <tbody>
              {calibration.records.map((r, i) => (
                <tr key={i} className="border-b hairline last:border-0">
                  <td className="py-1">{r.variable}</td>
                  <td className="font-mono">
                    {r.lead_band_h[0]}–{r.lead_band_h[1]} h
                  </td>
                  <td>{r.area}</td>
                  <td className="font-mono">{r.n_pairs}</td>
                  <td className="font-mono">{r.bias ?? 'n/a'}</td>
                  <td className="font-mono">{r.spread ?? 'n/a'}</td>
                  <td>
                    {Object.keys(r.coverage_classes ?? {}).includes('emulated') ? (
                      <EmulatedStamp />
                    ) : (
                      Object.keys(r.coverage_classes ?? {}).join(', ')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="font-sans text-[12px] text-ink-soft mt-3">
          {french
            ? 'Les comparaisons fondées sur ERA5 utilisent une réanalyse qui assimile des observations, sans constituer une vérité terrain indépendante (spécification §9). La taille des échantillons est toujours indiquée. Passage ne qualifie une probabilité d’étalonnée que lorsque l’historique le permet.'
            : 'ERA5 comparisons use a reanalysis that assimilates observations but is not independent ground truth (brief §9). Sample sizes are always shown. Passage calls a probability calibrated only when the record supports it.'}
        </p>
      </Panel>
    </div>
  );
}

function emulatedCaseLabel(caseIndex, french) {
  const count = caseIndex?.cases?.filter((item) => item.observation_source === 'emulated').length ?? 0;
  if (french) return `${count} ${count === 1 ? 'cas simulé affiché' : 'cas simulés affichés'} uniquement pour la démonstration.`;
  return `${count} emulated ${count === 1 ? 'case' : 'cases'} shown for demo only.`;
}

function coverageLabel(klass, french) {
  if (!french) return CLASS_LABEL[klass] ?? klass;
  const labels = {
    verified_near_observation: 'vérifié près d’une observation',
    partially_observed: 'partiellement observé',
    reanalysis_referenced: 'référencé par réanalyse',
    not_independently_observed: 'sans observation indépendante',
    emulated: 'observations simulées',
  };
  return labels[klass] ?? klass;
}
