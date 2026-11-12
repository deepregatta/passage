import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Briefing from '../src/pages/Briefing.jsx';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import { missingForecastHours } from '../src/lib/missingForecastHours.js';
import { useApp } from '../src/stores/appStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedBriefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => null }));

/** The demo check with every recorded limit status "ok" and a "within" verdict: a fully known passage. */
function knownWithin() {
  const f = structuredClone(savedFindings);
  for (const leg of f.legs) {
    for (const hour of leg.hours) {
      for (const key of Object.keys(hour.limit_status)) hour.limit_status[key] = 'ok';
    }
  }
  f.verdict = { state: 'within', driver_evidence_id: null, warning_override: { active: false, bulletin_ref: null } };
  return f;
}

const hourAt = (f, legId, time) => f.legs.find((leg) => leg.leg_id === legId).hours.find((hour) => hour.valid_time === time);

/** Three distinct valid times miss a value: a land-masked wave, a missing wave period, a wind beyond the horizon. */
function threeMissing() {
  const f = knownWithin();
  hourAt(f, 'L1', '2026-07-20T06:00:00Z').limit_status.wave = 'unknown';
  delete hourAt(f, 'L2', '2026-07-20T07:00:00Z').limit_status.steepness;
  // two legs at the same time count once
  hourAt(f, 'L1', '2026-07-20T08:00:00Z').limit_status.sustained = 'unknown';
  hourAt(f, 'L3', '2026-07-20T08:00:00Z').limit_status.wave = 'unknown';
  return f;
}

const MISSING_3 = 'A forecast value one of your limits needs is missing for 3 h of your arrival range: this check cannot say whether those hours stay inside your limits.';
const MISSING_3_FR = 'Il manque une valeur de prévision nécessaire à l’une de vos limites pendant 3 h de votre fenêtre d’arrivée estimée\u00A0: cette vérification ne peut pas dire si ces heures restent dans vos limites.';
const WITHIN_STEP = 'The forecast stays inside the limits you set. Check the latest run once more before you leave.';
const WITHIN_PARTIAL_STEP = 'Where the forecast has values, it stays inside the limits you set. Check the latest run once more before you leave.';
const WITHIN_PARTIAL_STEP_FR = 'Là où la prévision a des valeurs, elle reste dans les limites fixées. Vérifiez une dernière fois le cycle le plus récent avant de partir.';

describe('missingForecastHours', () => {
  it('counts distinct times of the arrival range missing a value a recorded limit needs', () => {
    expect(missingForecastHours(knownWithin())).toBe(0);
    expect(missingForecastHours(threeMissing())).toBe(3);
  });

  it('counts a declared layer that has no value in any hour, which a scan-wide count leaves out', () => {
    const f = knownWithin();
    for (const leg of f.legs) for (const hour of leg.hours) hour.limit_status.wave = 'unknown';
    const times = new Set(f.legs.flatMap((leg) => leg.hours.map((hour) => hour.valid_time)));
    expect(missingForecastHours(f)).toBe(times.size);
  });

  it('does not count a time already over a limit, as the departure grid does', () => {
    const f = threeMissing();
    hourAt(f, 'L1', '2026-07-20T06:00:00Z').limit_status.gust = 'exceeded';
    expect(missingForecastHours(f)).toBe(2);
  });

  it('reads nothing from a check without hours', () => {
    expect(missingForecastHours(null)).toBe(0);
    expect(missingForecastHours({ legs: [] })).toBe(0);
  });
});

describe('passage page: hours without a forecast value', () => {
  let findings;
  const band = () => within(screen.getByTestId('decision-band'));
  const show = (f) => {
    findings = f;
    useApp.setState({ ...useApp.getInitialState(), findings, briefing: structuredClone(savedBriefing), page: 'example' }, true);
    usePlayback.setState(usePlayback.getInitialState(), true);
  };
  beforeEach(() => show(knownWithin()));

  it('a fully known "within" check keeps its plain next step and says nothing about missing values', () => {
    render(<Briefing />);
    expect(band().getByText(WITHIN_STEP)).toBeInTheDocument();
    expect(screen.queryByTestId('missing-hours')).toBeNull();
  });

  it('a "within" check with missing hours says how many and qualifies the next step; the verdict stays', () => {
    show(threeMissing());
    render(<Briefing />);
    expect(band().getByTestId('missing-hours').textContent).toBe(MISSING_3);
    expect(band().getByText(WITHIN_PARTIAL_STEP)).toBeInTheDocument();
    expect(band().queryByText(WITHIN_STEP)).toBeNull();
    expect(band().getByText('Within your declared limits', { exact: true })).toBeVisible();
  });

  it('says it on any verdict, not only "within"', () => {
    const f = threeMissing();
    f.verdict.state = 'approaching';
    show(f);
    render(<Briefing />);
    expect(band().getByTestId('missing-hours').textContent).toBe(MISSING_3);
    expect(band().getByText('It is close to your limits. Read the weather story below before deciding.')).toBeInTheDocument();
  });

  it('in French', async () => {
    show(threeMissing());
    const { container } = render(<div id="root"><Briefing /><LocalizedDocument language="fr" /></div>);
    await waitFor(() => expect(screen.getByTestId('missing-hours').textContent).toBe(MISSING_3_FR));
    expect(container.querySelector('[data-testid="decision-band"]')).toHaveTextContent(WITHIN_PARTIAL_STEP_FR);
    expect(container.querySelector('[data-testid="decision-band"]').textContent).not.toMatch(/arrival range|forecast value|Where the forecast/);
  });

  it('translates the singular count', () => {
    expect(translateText('A forecast value one of your limits needs is missing for 1 h of your arrival range: this check cannot say whether those hours stay inside your limits.', 'fr'))
      .toBe('Il manque une valeur de prévision nécessaire à l’une de vos limites pendant 1 h de votre fenêtre d’arrivée estimée\u00A0: cette vérification ne peut pas dire si ces heures restent dans vos limites.');
  });
});
