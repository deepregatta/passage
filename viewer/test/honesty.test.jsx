import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import BulletinPanel from '../src/components/BulletinPanel.jsx';
import SynopticHero from '../src/components/SynopticHero.jsx';
import Planner from '../src/pages/Planner.jsx';
import Briefing from '../src/pages/Briefing.jsx';
import { useApp } from '../src/stores/appStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';
import { translateText } from '../src/i18n.js';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>, TileLayer: () => null,
  Marker: () => null, Polyline: () => null,
  useMap: () => ({ fitBounds: vi.fn() }), useMapEvents: vi.fn(),
}));
vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => null }));
const fixture = (name) => JSON.parse(readFileSync(resolve(import.meta.dirname, `fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/${name}.json`), 'utf8'));
let findings;
let warnings;
beforeEach(() => {
  findings = fixture('findings');
  warnings = fixture('warnings');
  useApp.setState({ findings, warnings, briefing: fixture('briefing'), route: fixture('route'),
    synoptic: fixture('synoptic'), manifest: { snapshots: [] }, loading: false, language: 'en' });
  usePlayback.setState({ cursorHours: 0, focusedEventId: null, departureVariant: 'alternative' });
});

it.each(['evidence', 'document'])('badges emulated bulletins from %s provenance', (source) => {
  const evidence = { ...findings.evidence.find(e => e.rule_id === 'A-WARN-01'), source_kind: source === 'evidence' ? 'emulated' : 'warning' };
  if (source === 'evidence') useApp.setState({ warnings: null });
  render(<BulletinPanel evidence={evidence} onClose={() => {}} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('EMULATED WARNING SCENARIO');
});
it('keeps real archived bulletins distinct from emulated ones', () => {
  warnings.source.mode = 'fixture';
  useApp.setState({ warnings });
  const evidence = { ...findings.evidence.find(e => e.rule_id === 'A-WARN-01'), source_kind: 'warning' };
  render(<BulletinPanel evidence={evidence} onClose={() => {}} />);
  expect(screen.queryByText('EMULATED WARNING SCENARIO')).toBeNull();
  expect(screen.getByText('Source bulletin')).toBeVisible();
});
it('does not offer an official bulletin action for a non-demo emulated warning', () => {
  render(<Briefing />);
  expect(screen.queryByRole('button', { name: 'Open official bulletin' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Inspect emulated bulletin' })).toBeVisible();
});
it('removes the fake comparison control and shifted route in both chart modes', () => {
  const { container } = render(<SynopticHero />);
  expect(screen.queryByRole('button', { name: /safer departure/i })).toBeNull();
  expect(container.querySelector('polyline[transform]')).toBeNull();
  fireEvent.error(container.querySelector('img'));
  expect(container.querySelector('polyline[transform]')).toBeNull();
});
it('does not advertise providers before a passage is assessed', () => {
  useApp.setState({ findings: null });
  render(<Planner />);
  expect(screen.getByText('Check a passage to record its models and coverage.')).toBeInTheDocument();
  expect(screen.queryByText(/Winds and gusts along your route: NOAA/)).toBeNull();
});
it('shows only recorded models and the actual coverage of the open briefing', () => {
  findings.inputs.forecast_tiles = [{ layer: 'ensemble', model: 'test-model', run_id: 'run-42', source: 'tiles', member_count: 7 }];
  findings.coverage = [{ capability: 'tidal_gates', status: 'not_assessed' }, { capability: 'official_warnings', status: 'assessed_emulated' }];
  render(<Planner />);
  const panel = screen.getByText('Models and coverage').closest('details');
  fireEvent.click(within(panel).getByText('Models and coverage'));
  expect(panel).toHaveTextContent('test-model');
  expect(panel).toHaveTextContent('run-42');
  expect(panel).toHaveTextContent('7 members');
  expect(panel).toHaveTextContent(findings.route_id);
  expect(within(panel).getByText('tidal gates').closest('li')).toHaveTextContent('not assessed');
  expect(within(panel).getByText('official warnings').closest('li')).toHaveTextContent('assessed emulated');
  expect(panel).not.toHaveTextContent('CMEMS');
  expect(panel).not.toHaveTextContent('gfs_0p25');
});
it('reports missing legacy records without inventing models or coverage', () => {
  delete findings.inputs.forecast_tiles;
  delete findings.coverage;
  render(<Planner />);
  expect(screen.getByText('Model records unavailable for this briefing.')).toBeInTheDocument();
  expect(screen.getByText('Coverage records unavailable for this briefing.')).toBeInTheDocument();
});

it('translates the new disclosure copy and recorded fields into French', () => {
  const translations = {
    'Emulated bulletin': 'Bulletin simulé',
    'Emulated bulletin. Do not use for a real passage decision.': 'Bulletin simulé. Ne l’utilisez pas pour prendre une décision de traversée réelle.',
    'Inspect emulated bulletin': 'Examiner le bulletin simulé',
    'Models and coverage': 'Modèles et couverture',
    'Check a passage to record its models and coverage.': 'Évaluez une traversée pour enregistrer ses modèles et sa couverture.',
    'Open briefing': 'Briefing ouvert',
    'Recorded models': 'Modèles enregistrés',
    'Recorded coverage': 'Couverture enregistrée',
    'Model records unavailable for this briefing.': 'Les modèles utilisés ne sont pas enregistrés dans ce briefing.',
    'Coverage records unavailable for this briefing.': 'La couverture évaluée n’est pas enregistrée dans ce briefing.',
    'Wind and gusts': 'Vent et rafales', 'Ensemble': 'Ensemble',
    'Additional weather model': 'Modèle météo complémentaire',
    'Surface currents': 'Courants de surface', 'Forecast tiles': 'Tuiles de prévision',
    'Fixture data': 'Données de test', 'Source not recorded': 'Source non enregistrée',
    '7 members': '7 membres', 'assessed emulated': 'évalué (simulé)',
  };
  for (const [english, french] of Object.entries(translations)) {
    expect(translateText(english, 'fr')).toBe(french);
  }
});
