import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import synoptic from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/synoptic.json';
import route from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/route.json';
import { useApp } from '../src/stores/appStore.js';
import SynopticHero from '../src/components/SynopticHero.jsx';

afterEach(() => { cleanup(); useApp.setState({ findings: null, synoptic: null, route: null }); });

it('puts the interception banner below the chart, not over it, and fills the viewport in full screen', () => {
  useApp.setState({ findings, synoptic, route });
  render(<SynopticHero />);
  const banner = screen.getByText(/^(cause|interception|consequence|easing) · /);
  const panel = banner.parentElement;
  expect(panel.className).not.toMatch(/\babsolute\b/);
  const chart = screen.getByRole('img', { name: /track and route occupancy/ }).closest('.overflow-hidden');
  expect(chart.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Full chart' })).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.style.height).toBe('100dvh');
  fireEvent.click(screen.getAllByRole('button', { name: 'Full chart' }).at(-1));
  expect(screen.getAllByRole('button', { name: 'Zoom to route' }).length).toBeGreaterThan(0);
});
