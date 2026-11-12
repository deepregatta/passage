import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ModelsUsed from '../src/components/ModelsUsed.jsx';
import { LocalizedDocument, translateText } from '../src/i18n.js';
import { deriveCoverage } from '../src/lib/evidenceSelectors.js';
import { useApp } from '../src/stores/appStore.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';

afterEach(cleanup);

const allOk = () => {
  const f = structuredClone(savedFindings);
  for (const leg of f.legs) for (const hour of leg.hours) for (const key of Object.keys(hour.limit_status)) hour.limit_status[key] = 'ok';
  return f;
};
const item = (f, capability) => deriveCoverage(f).items.find((i) => i.capability === capability);
const total = (f) => f.legs.reduce((n, leg) => n + leg.hours.length, 0);

describe('coverage corrected by hours with a value', () => {
  it('leaves a fully known check as recorded', () => {
    const f = allOk();
    for (const c of ['sustained_wind', 'gusts', 'waves', 'visibility_and_convection']) {
      expect(item(f, c)).toEqual(f.coverage.find((i) => i.capability === c));
    }
  });

  it('turns an assessed layer partial when some hours miss its value, naming the hours', () => {
    const f = allOk();
    f.coverage.find((i) => i.capability === 'waves').status = 'assessed';
    f.legs[0].hours[0].limit_status.wave = 'unknown';
    delete f.legs[1].hours[0].limit_status.wave;
    const waves = item(f, 'waves');
    expect(waves.status).toBe('partially_assessed');
    expect(waves.detail).toBe(`wave values available for ${total(f) - 2}/${total(f)} route hours`);
  });

  it('turns a layer with no value in any hour into not assessed', () => {
    const f = allOk();
    f.coverage.find((i) => i.capability === 'sustained_wind').status = 'assessed';
    for (const leg of f.legs) for (const hour of leg.hours) hour.limit_status.sustained = 'unknown';
    expect(item(f, 'sustained_wind').status).toBe('not_assessed');
  });

  it('does not touch a layer the check never recorded, nor change the saved findings', () => {
    const f = allOk();
    for (const leg of f.legs) for (const hour of leg.hours) delete hour.limit_status.visibility;
    const bytes = JSON.stringify(f);
    expect(item(f, 'visibility_and_convection')).toEqual(f.coverage.find((i) => i.capability === 'visibility_and_convection'));
    expect(JSON.stringify(f)).toBe(bytes);
  });

  it('shows the hour count in the panel, in English and French', () => {
    const f = allOk();
    f.coverage.find((i) => i.capability === 'gusts').status = 'assessed';
    f.legs[0].hours[0].limit_status.gust = 'unknown';
    useApp.setState({ ...useApp.getInitialState(), findings: f }, true);
    const { container } = render(<div><ModelsUsed /><LocalizedDocument language="en" /></div>);
    fireEvent.click(screen.getByText('Models and coverage'));
    const row = within(screen.getByRole('region', { name: 'Recorded coverage' })).getByText('gusts').closest('li');
    expect(row.textContent).toContain(`gust values available for ${total(f) - 1}/${total(f)} route hours`);
    expect(translateText('gust values available for 5/8 route hours', 'fr')).toBe('valeurs de rafales disponibles pour 5/8 heures de route');
    expect(translateText('wind values available for 5/8 route hours', 'fr')).toBe('valeurs de vent disponibles pour 5/8 heures de route');
    expect(translateText('wave values available for 5/8 route hours', 'fr')).toBe('valeurs de vagues disponibles pour 5/8 heures de route');
    expect(translateText('visibility values available for 5/8 route hours', 'fr')).toBe('valeurs de visibilité disponibles pour 5/8 heures de route');
    expect(container).toBeTruthy();
  });
});
