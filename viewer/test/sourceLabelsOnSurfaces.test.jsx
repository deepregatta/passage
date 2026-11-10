import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BulletinPanel from '../src/components/BulletinPanel.jsx';
import EvidenceInspector from '../src/components/EvidenceInspector.jsx';
import { fmtTextTime, fmtUtcClock } from '../src/lib/format.js';
import { useApp } from '../src/stores/appStore.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedWarnings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/warnings.json';

afterEach(() => vi.useRealTimers());
beforeEach(() => {
  useApp.setState({ ...useApp.getInitialState(), findings: structuredClone(savedFindings), warnings: structuredClone(savedWarnings) }, true);
});

const withoutProvenance = (node) => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('details').forEach((details) => details.remove());
  return copy.textContent;
};

it('the evidence inspector names the claim, place, source and run; raw ids sit under Provenance', () => {
  const claim = savedFindings.evidence.find((item) => item.rule_id === 'W-SUST-03' && item.leg_id === 'L4');
  useApp.setState({ nowMs: Date.parse('2026-11-10T00:00:00Z') });
  useApp.getState().openEvidence(claim.evidence_id);
  const { baseElement } = render(<EvidenceInspector />);
  const dialog = baseElement.querySelector('[role="dialog"]');
  const text = withoutProvenance(dialog);
  expect(text).toContain('wind scenarios over your limit');
  expect(text).toContain('Mid-Channel (leg 4)');
  expect(text).toContain('Scenario set (emulated)');
  expect(text).toContain('113 days');
  expect(text).toContain(fmtTextTime(claim.valid_time));
  expect(text).toContain(fmtUtcClock(claim.valid_time));
  expect(text).not.toMatch(/W-SUST-03|\bL4\b|scenario-|2\d{3} h/);
  expect(dialog.querySelector('details')).toHaveTextContent(`rule ${claim.rule_id}`);
  expect(dialog.querySelector('details')).toHaveTextContent(`leg ${claim.leg_id}`);
});

it('the bulletin panel reads an old issue time in days and gives times in the header zone with UTC secondary', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-10T00:00:00Z'));
  const evidence = savedFindings.evidence.find((item) => item.rule_id === 'A-WARN-01');
  const ref = evidence.bulletin_ref;
  const { container } = render(<BulletinPanel evidence={evidence} onClose={() => {}} />);
  const rows = container.querySelector('dl').textContent;
  expect(rows).toContain(fmtTextTime(ref.issued_at));
  expect(rows).toContain(fmtUtcClock(ref.issued_at));
  expect(rows).toMatch(/\d+ days old/);
  expect(rows).not.toMatch(/\d{4} h old/);
});
