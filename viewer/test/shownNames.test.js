import { describe, expect, it } from 'vitest';

// Names from check content shown as names (the one cleaning rule, engine cleanPassageName):
// a route's name, a leg's place names, a gate's name. Sentences are never cut by it.
describe('a name shown from check content', () => {
  it('that would render blank falls back to the default passage name', async () => {
    const { passageDefaultName, userRouteName } = await import('../src/lib/passages.js');
    const blank = { name: '\u3164\u3164', mode: 'draw' };
    expect(passageDefaultName(blank, 'cherbourg-plymouth-v1', 'en')).toBe('Cherbourg plymouth');
    expect(userRouteName(blank)).toBeNull();
  });

  it('loses a bidirectional control in a leg name, as a place in a sentence and as the bare place', async () => {
    const { legLabel, legPlace, routeTitle } = await import('../src/pages/briefing/routeLabels.jsx');
    const findings = { route_id: 'x', legs: [{ leg_id: 'L1', name: 'Brest → Camaret' }, { leg_id: 'L2', name: 'Camaret → Ouessant \u202E' }] };
    expect(legPlace(findings, 'L2')).toBe('near Ouessant');
    expect(legLabel(findings, 'L2')).toBe('near Ouessant (leg 2)');
    expect(legLabel(findings, 'L2', { bare: true })).toBe('Ouessant (leg 2)');
    expect(routeTitle(findings)).toBe('Brest → Ouessant');
  });
});

describe('the planner, when a check is revised', () => {
  it('takes the route\'s name cleaned by the one rule (the next check\'s name; no saved hash changes)', async () => {
    const { render, screen, fireEvent } = await import('@testing-library/react');
    const { createElement } = await import('react');
    const { useApp } = await import('../src/stores/appStore.js');
    const { usePlanner } = await import('../src/stores/plannerStore.js');
    const { default: DecisionBand } = await import('../src/pages/briefing/DecisionBand.jsx');
    const findings = (await import('./fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/findings.json')).default;
    const fixtureRoute = (await import('./fixtures/demo/snapshots/snapshot_v2_406ad333228b0a73/route.json')).default;
    const route = { ...fixtureRoute, name: 'Brest\u202E → Yeu\u200B' };
    useApp.setState({ route, findings, warnings: null, page: 'briefing' });
    render(createElement(DecisionBand, { findings: { ...findings, identity_version: 2 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Revise this passage' }));
    expect(usePlanner.getState().name).toBe('Brest → Yeu');
    expect(route.name).toBe('Brest\u202E → Yeu\u200B');
  });
});
