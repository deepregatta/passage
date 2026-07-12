import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';

beforeEach(() => {
  history.replaceState(null, '', '#plan/briefings');
  useApp.setState({
    page: 'snapshots',
    manifest: null,
    manifestError: null,
    snapshotId: null,
    findings: null,
    briefing: null,
    plume: null,
    snapshot: null,
    warnings: null,
    synoptic: null,
    route: null,
    loadError: null,
    loading: false,
    inspectorEvidenceId: null,
    selectedEvidenceId: null,
    inspectorOpen: false,
    selectedLegId: null,
  });
});

describe('viewer fixture harness', () => {
  it('serves the generated reference snapshot through the same /data paths as Vite', async () => {
    const user = userEvent.setup();
    render(<App />);

    const [snapshot] = await screen.findAllByRole('button', { name: /cherbourg plymouth/i });
    await user.click(snapshot);

    await waitFor(() => expect(screen.getByText(/EMULATED WARNING SCENARIO/i)).toBeTruthy());
    expect(useApp.getState().snapshotId).toBe('20260720T060000Z_44d2cd5f_f0703423');
  });

  it('does not present emulated warning evidence as verified authority', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByRole('button', { name: /cherbourg plymouth/i }))[0]);
    expect(screen.getByText(/EMULATED WARNING SCENARIO/i)).toBeTruthy();
  });

  it('never lists an active warning capability as unsupported', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click((await screen.findAllByRole('button', { name: /cherbourg plymouth/i }))[0]);
    await user.click(await screen.findByRole('button', { name: /Why this assessment/i }));
    expect(screen.queryByText(/does NOT cover:.*official marine warnings/i)).toBeNull();
  });
});
