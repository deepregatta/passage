// Synthetic transport inputs shared by planner unit and browser regressions.
export const DEPARTURE = '2026-07-20T00:00:00Z';
export function routingInputs(along = 2, maxHours = 48) {
  const grid = (kind, u, v) => ({
    schema_version: 1, kind, run_id: `test-${kind}-${u}`, generated_at: DEPARTURE,
    lat0: 49, lon0: -4, dlat: 0.5, dlon: 0.5, nlat: 3, nlon: 4,
    time_axis: [DEPARTURE, '2026-07-30T00:00:00Z'],
    u_kt: Array(24).fill(u), v_kt: Array(24).fill(v), source: { mode: 'synthetic' },
  });
  return {
    start: { lat: 49.5, lon: -3.5 }, finish: { lat: 49.5, lon: -3.2 }, maxHours, notes: [],
    polar: { schema_version: 1, polar_id: 'constant-5', label: 'Constant 5 kt',
      tws_kt: [6, 20], twa_deg: [45, 180], speeds_kt: [[5, 5], [5, 5]], source: { kind: 'generic' } },
    windGrid: grid('wind10m', 0, -12), currentGrid: grid('surface_current', along, 0),
  };
}
export function auditStore({ ScenarioBundleStore }, currentGrid) {
  const times = Array.from({ length: 241 }, (_, h) => new Date(Date.parse(DEPARTURE) + h * 3600_000).toISOString().slice(0, 16));
  const store = new ScenarioBundleStore({ loadBundle: async (name) => name === 'forecast' ? {
    hourly: { time: times, wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 15), wind_direction_10m: times.map(() => 90) },
  } : null });
  store.getCurrentGrid = async () => currentGrid;
  return store;
}
