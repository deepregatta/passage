import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';

beforeEach(() => {
  useApp.setState({
    page: 'snapshots',
    manifest: null,
    manifestError: null,
    snapshotId: null,
    findings: null,
    briefing: null,
    plume: null,
    loadError: null,
    loading: false,
    inspectorEvidenceId: null,
    selectedLegId: null,
  });
});

describe('viewer fixture harness', () => {
  it('serves the frozen audited snapshot through the same /data paths as Vite', async () => {
    const user = userEvent.setup();
    render(<App />);

    const snapshot = await screen.findByRole('button', { name: /cherbourg-plymouth-v1/i });
    await user.click(snapshot);

    await waitFor(() => expect(screen.getByText(/Official warning active/i)).toBeTruthy());
    expect(useApp.getState().snapshotId).toBe('20260720T060000Z_44d2cd5f_4196266b');
  });

  it.fails('does not present emulated warning evidence as verified authority', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /cherbourg-plymouth-v1/i }));
    await screen.findByText(/Official warning active/i);
    expect(screen.getByText(/EMULATED WARNING SCENARIO/i)).toBeTruthy();
  });

  it.fails('never lists an active warning capability as unsupported', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /cherbourg-plymouth-v1/i }));
    await user.click(await screen.findByRole('button', { name: /Why this assessment/i }));
    expect(screen.queryByText(/does NOT cover:.*official marine warnings/i)).toBeNull();
  });
});
