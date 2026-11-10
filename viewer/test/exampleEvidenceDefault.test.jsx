import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import Example from '../src/pages/Example.jsx';
import { useApp } from '../src/stores/appStore.js';
import { usePlayback } from '../src/stores/playbackStore.js';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => null }));

beforeEach(() => {
  history.replaceState(null, '', '/#example');
  useApp.setState({ ...useApp.getInitialState(), page: 'example' }, true);
  usePlayback.setState(usePlayback.getInitialState(), true);
});

// Loaded the way the app loads it: openSnapshot used to preselect the verdict driver (E9, leg 4,
// 51 of 51), which the Evidence section follows, so it contradicted the top sentence (leg 3, 24 of 51).
it('the loaded example opens Evidence on the claim the verdict sentence quotes', async () => {
  await useApp.getState().loadExample();
  expect(useApp.getState()).toMatchObject({ selectedEvidenceId: 'E5', selectedLegId: 'L3' });
  render(<Example />);
  const top = within(await screen.findByTestId('decision-band')).getByTestId('verdict-detail');
  expect(top).toHaveTextContent('24 of 51 emulated forecast scenarios exceed that limit.');
  const evidence = document.querySelector('[data-section="evidence"]');
  expect(within(evidence).getByRole('heading', { level: 2 })).toHaveTextContent('24 of 51 forecast scenarios exceed your wind limit');
});
