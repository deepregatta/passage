import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../src/App.jsx';
import { useApp } from '../src/stores/appStore.js';

beforeEach(() => {
  localStorage.removeItem('passage-language');
  history.replaceState(null, '', '#brief/briefings');
  useApp.setState({
    language: 'en',
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
  it('places My briefings in the Brief menu', () => {
    render(<App />);

    expect(screen.getAllByRole('button', { name: /Brief$/ }).some((button) => button.getAttribute('aria-current') === 'page')).toBe(true);
    expect(screen.getByRole('button', { name: 'My briefings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Passage' })).toBeNull();
  });

  it('shows the shared DeepRegatta company links on every Passage view', () => {
    render(<App />);

    expect(screen.getByText(/A DeepRegatta instrument for offshore sailors/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('https://deepregatta.com/privacy');
    expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('https://deepregatta.com/terms');
    expect(screen.getByRole('link', { name: 'Legal notice' }).getAttribute('href')).toBe('https://deepregatta.com/legal');
    expect(screen.getByRole('link', { name: 'contact@deepregatta.com' }).getAttribute('href')).toBe('mailto:contact@deepregatta.com');
  });

  it('switches the whole interface to French and remembers the choice', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Français' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Mes briefings' })).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /Planifier$/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Confidentialité' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');
    expect(localStorage.getItem('passage-language')).toBe('fr');

    await user.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'My briefings' })).toBeTruthy());
    expect(document.documentElement.lang).toBe('en');
  });

  it('serves the generated reference snapshot through the same /data paths as Vite', async () => {
    const user = userEvent.setup();
    render(<App />);

    const [snapshot] = await screen.findAllByRole('button', { name: /cherbourg plymouth/i });
    await user.click(snapshot);

    await waitFor(() => expect(screen.getByText(/EMULATED WARNING SCENARIO/i)).toBeTruthy());
    expect(useApp.getState().snapshotId).toBe('20260720T060000Z_44d2cd5f_64ea971e');
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
