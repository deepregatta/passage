import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ChangesSection from '../src/pages/briefing/ChangesSection.jsx';
import { governingClaim, safeGoverningReason } from '../src/lib/governing.js';
import { useApp } from '../src/stores/appStore.js';
import findings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import briefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';
import synoptic from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/synoptic.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));

beforeEach(() => {
  useApp.setState({ ...useApp.getInitialState(), findings: structuredClone(findings), briefing: structuredClone(briefing), synoptic, snapshotSource: 'served', page: 'briefing' }, true);
});

it('states scenario shares as counts of scenarios, never in wind units', async () => {
  const { container } = render(<ChangesSection />);
  await screen.findByText('Event onset at the route');
  const ledger = container.querySelector('details ul');
  expect(ledger).toHaveTextContent('gust scenarios over your limit near Plymouth approach (E of Eddystone): 40 → 51 of 51 scenarios');
  const scenarioLines = [...ledger.querySelectorAll('li')].filter((li) => /scenarios over your limit/.test(li.textContent) && /\d+ →/.test(li.textContent) && !/ h (earlier|later)/.test(li.textContent));
  expect(scenarioLines.length).toBeGreaterThan(0);
  for (const li of scenarioLines) expect(li.textContent).not.toMatch(/\bkt\b/);
});

it('names no driver claim other than the one the top verdict sentence rests on', async () => {
  const governing = governingClaim(findings, safeGoverningReason(findings, null));
  expect(governing.evidence_id).toBe('E5');
  expect(findings.verdict.driver_evidence_id).toBe('E9');
  const { container } = render(<ChangesSection />);
  await screen.findByText('Event onset at the route');
  const cards = [...container.querySelectorAll('article')];
  const text = cards.map((card) => card.textContent).join(' ');
  expect(text).not.toMatch(/currently driving/);
  const driverCards = cards.filter((card) => /driv|governing|rests on/i.test(card.textContent));
  for (const card of driverCards) {
    const ids = [...card.querySelectorAll('.evidence-link')].map((chip) => chip.getAttribute('title'));
    expect(ids).toEqual([governing.evidence_id]);
  }
  // the governing claim is the one promoted and described as the verdict's basis
  expect(driverCards).toHaveLength(1);
  expect(driverCards[0]).toHaveTextContent('This is the claim the verdict sentence rests on.');
  // the engine verdict driver's (E9) own change is no longer presented as what drives the assessment
  expect(cards.some((card) => [...card.querySelectorAll('.evidence-link')].some((chip) => chip.getAttribute('title') === 'E9'))).toBe(false);
});
