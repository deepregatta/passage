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
    expect(screen.getByText('weather-ecmwf-short-20261001T06Z')).toBeInTheDocument();
    expect(screen.getByText('weather-ecmwf-20261001T00Z')).toBeInTheDocument();
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
    expect(screen.getByText('weather-ecmwf-short-20261001T06Z')).toBeInTheDocument();
  });
});
