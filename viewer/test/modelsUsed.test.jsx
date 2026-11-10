import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import ModelsUsed from '../src/components/ModelsUsed.jsx';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';

const tiles = (layer, model, run_id, cycle, served) => ({
  source: 'tiles', layer, model, run_id, cycle, resolution_deg: 0.25, tiles: ['N40W010'],
  fetched_at: '2026-10-01T14:00:00Z', cached_tiles: 0, points: 3, ...(served ? { served } : {}),
});

/** A briefing analysed at 14:00 on 1 Oct, after ECMWF's 06Z run went live. */
function findingsWith(ecmwfInputs) {
  return {
    legs: [],
    coverage: [],
    inputs: {
      forecast_tiles: [tiles('weather', 'gfs_0p25', 'weather-20261001T06Z', '2026-10-01T06:00Z'), ...ecmwfInputs],
    },
  };
}

const COMBINED = [
  tiles('weather-ecmwf', 'ecmwf_ifs_0p25', 'weather-ecmwf-20261001T00Z', '2026-10-01T00:00Z', [
    { from: '2026-10-01T00:00:00Z', to: '2026-10-01T05:00:00Z' },
    { from: '2026-10-07T07:00:00Z', to: '2026-10-08T00:00:00Z' },
  ]),
  tiles('weather-ecmwf-short', 'ecmwf_ifs_0p25', 'weather-ecmwf-short-20261001T06Z', '2026-10-01T06:00Z', [
    { from: '2026-10-01T06:00:00Z', to: '2026-10-07T06:00:00Z' },
  ]),
];

afterEach(cleanup);

describe('Models used: ECMWF runs', () => {
  it('lists both ECMWF runs and names the cycle per time range', () => {
    useApp.setState({ findings: findingsWith(COMBINED), nowMs: Date.parse('2026-10-01T14:00:00Z') });
    render(<ModelsUsed />);
    expect(screen.getByText('ECMWF run 1 Oct 06Z')).toBeInTheDocument();
    expect(screen.getByText('ECMWF run 1 Oct 00Z')).toBeInTheDocument();
    expect(screen.getAllByText('Additional weather model')).toHaveLength(2);
    expect(screen.getByText('Model comparison uses')).toBeInTheDocument();
    expect(screen.getByText('ECMWF 06Z to +144 h, then 00Z')).toBeInTheDocument();
  });

  it('adds nothing for a briefing whose ECMWF series came from one run', () => {
    useApp.setState({
      findings: findingsWith([tiles('weather-ecmwf', 'ecmwf_ifs_0p25', 'weather-ecmwf-20261001T00Z', '2026-10-01T00:00Z')]),
      nowMs: Date.parse('2026-10-01T14:00:00Z'),
    });
    render(<ModelsUsed />);
    expect(screen.queryByText('Model comparison uses')).not.toBeInTheDocument();
  });

  it('translates the label under the French localiser and keeps run ids', async () => {
    useApp.setState({ findings: findingsWith(COMBINED), nowMs: Date.parse('2026-10-01T14:00:00Z') });
    render(<div id="root"><ModelsUsed /><LocalizedDocument language="fr" /></div>);
    await waitFor(() => expect(screen.getByText('ECMWF 06Z jusqu’à +144 h, puis 00Z')).toBeInTheDocument());
    expect(screen.getByText('La comparaison des modèles utilise')).toBeInTheDocument();
    expect(screen.getByText('cycle ECMWF du 1 oct. 06Z')).toBeInTheDocument();
    expect(screen.getByText('weather-ecmwf-short-20261001T06Z')).toBeInTheDocument();
  });
});

describe('Models used: human names, raw ids only under Provenance', () => {
  const emulated = (layer, runId) => ({ ...tiles(layer, 'scenario', runId, 'scenario'), source: 'fixture', fetched_at: '2026-07-19T18:00:00Z' });

  it('shows source names, run labels and ages in days, with raw ids inside a Provenance disclosure', () => {
    const currents = { source: 'region-grid', layer: 'currents', model: 'cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m', run_id: 'prepared-20261001T00Z', fetched_at: '2026-10-01T09:00:00Z', mode: 'live' };
    useApp.setState({
      findings: { ...findingsWith([currents]), legs: [] },
      nowMs: Date.parse('2026-10-01T14:00:00Z'),
    });
    const { container } = render(<ModelsUsed />);
    expect(screen.getByText('GFS 0.25°')).toBeInTheDocument();
    expect(screen.getByText('GFS run 1 Oct 06Z')).toBeInTheDocument();
    expect(screen.getByText('Copernicus IBI ocean currents')).toBeInTheDocument();
    const visible = (node) => [...node.querySelectorAll('li')].map((li) => {
      const copy = li.cloneNode(true);
      copy.querySelectorAll('details').forEach((d) => d.remove());
      return copy.textContent;
    }).join(' ');
    expect(visible(container)).not.toMatch(/weather-2026|gfs_0p25|cmems_mod|_/);
    const provenance = [...container.querySelectorAll('details details')];
    expect(provenance).toHaveLength(2);
    expect(provenance[0]).toHaveTextContent('gfs_0p25 · weather-20261001T06Z');
    expect(provenance[1]).toHaveTextContent('cmems_mod_ibi_phy_anfc_0.027deg-3D_PT1H-m');
  });

  it('names emulated scenario sets, keeps the emulated badge and reads old runs in days', () => {
    useApp.setState({
      findings: { legs: [], coverage: [], inputs: { forecast_tiles: [emulated('weather', 'scenario-74bece95')] } },
      nowMs: Date.parse('2026-11-10T00:00:00Z'),
    });
    const { container } = render(<ModelsUsed />);
    expect(screen.getByText('Scenario set (emulated)')).toBeInTheDocument();
    expect(container.querySelector('.stamp-emulated')).toHaveTextContent('Fixture data');
    expect(container).toHaveTextContent('age 113 days');
    expect(container).not.toHaveTextContent(/\d{4} h/);
    expect(container.querySelector('details details')).toHaveTextContent('scenario · scenario-74bece95');
  });
});
