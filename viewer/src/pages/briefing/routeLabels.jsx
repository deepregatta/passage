import { placeLabel } from '../../lib/format.js';

// Kept in JSX so the viewer translation scanner covers these shared labels.

export const legPlace = (findings, legId) => {
  const leg = findings.legs.find((l) => l.leg_id === legId);
  return leg ? `near ${shortName(leg.name)}` : legId;
};

const shortName = (name) => placeLabel(name.split('→')[1]?.trim().split(',')[0] ?? name.slice(0, 24));

export function routeTitle(findings) {
  const first = findings.legs[0];
  const last = findings.legs[findings.legs.length - 1];
  const from = placeLabel(first?.name.split('→')[0]?.trim().split(',')[0] ?? findings.route_id);
  const to = placeLabel(last?.name.split('→')[1]?.trim().split(',')[0] ?? '');
  return to ? `${from} → ${to}` : from;
}
