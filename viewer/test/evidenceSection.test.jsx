import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import EvidenceSection from '../src/pages/briefing/EvidenceSection.jsx';
import { fmtTextTime, fmtUtcClock } from '../src/lib/format.js';
import { LocalizedDocument } from '../src/i18n.js';
import { useApp } from '../src/stores/appStore.js';
import { governingReason } from '@deepweather/engine';
import { governingClaim } from '../src/pages/briefing/verdictSentence.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedPlume from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/plume.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));

let findings;
beforeEach(() => {
  findings = structuredClone(savedFindings);
  useApp.setState({ ...useApp.getInitialState(), findings, plume: structuredClone(savedPlume), selectedEvidenceId: null }, true);
});

it('states the exceedance count once, in the claim headline', () => {
  const { container } = render(<EvidenceSection />);
  const headline = screen.getByRole('heading', { level: 2 });
  expect(headline).toHaveTextContent(/^\d+ of 51 forecast scenarios exceed your (wind|gust) limit$/);
  // the chooser, the side panel and the table caption repeat neither count nor fraction
  const text = container.textContent;
  expect(text.match(/(?<!\d)\d+ of 51(?!\d)/g)).toHaveLength(1);
  expect(text).not.toMatch(/\d+\/51 over/);
  expect(text).not.toMatch(/Raw fraction/);
});

it('shows friendly labels, never claim codes or raw L-ids', () => {
  const { container } = render(<EvidenceSection />);
  expect(container.textContent).not.toMatch(/\b[WSTCAV]-[A-Z]+-\d\d\b/);
  expect(container.textContent).not.toMatch(/\bL\d\b/);
  expect(container.querySelector('.eyebrow').textContent).toMatch(/Claim-level evidence · (wind|gust) scenarios over your limit/);
  const chooser = screen.getByRole('complementary', { name: 'Evidence claims' });
  const buttons = within(chooser).getAllByRole('button');
  expect(buttons.length).toBeGreaterThan(1);
  for (const button of buttons) {
    expect(button.textContent).toMatch(/\(leg \d\)(wind|gust)$/);
    expect(button.className).toMatch(/min-h-11/);
  }
});

it('uses the header zone for claim times, with a marked UTC secondary only in the side panel', () => {
  const { container } = render(<EvidenceSection />);
  // the default claim is the one the verdict sentence at the top quotes
  const claim = governingClaim(findings, governingReason(findings));
  const subline = [...container.querySelectorAll('p')].find((p) => p.textContent.includes('inspect claim'));
  expect(subline.textContent).toContain(fmtTextTime(claim.valid_time));
  const panel = screen.getByLabelText('Selected evidence summary');
  expect(panel).toHaveTextContent(fmtUtcClock(claim.valid_time));
  expect(subline.textContent).not.toMatch(/UTC/);
});

it('translates the leg labels, claim label and table headers into French', async () => {
  const { container } = render(<div id="root"><EvidenceSection /><LocalizedDocument language="fr" /></div>);
  await waitFor(() => expect(container.textContent).toContain('(tronçon 4)'));
  expect(container.textContent).not.toMatch(/\(leg \d\)/);
  expect(container.querySelector('.eyebrow').textContent).toMatch(/scénarios de (vent|rafales) au-dessus de votre limite/);
  expect(container.querySelector('thead').textContent).toContain('heure locale');
});
