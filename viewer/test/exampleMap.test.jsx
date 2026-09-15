import { act, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useApp } from '../src/stores/appStore.js';
import RouteMap from '../src/components/RouteMap.jsx';
import { preparedRun } from '../src/lib/preparedRun.js';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div>{children}</div>,
  TileLayer: () => null, Marker: () => null, Polyline: () => null, Tooltip: () => null,
}));
vi.mock('../src/lib/preparedRun.js', () => ({
  preparedRun: vi.fn(async () => ({ doc: {} })), artifactUrl: vi.fn(),
}));

it('renders stored example route data without fetching current wind, including after a real briefing', async () => {
  useApp.setState({ page: 'example', manifest: null });
  await useApp.getState().loadExample();
  preparedRun.mockClear();
  const demoManifest = useApp.getState().manifest;
  const view = render(<RouteMap />);
  await waitFor(() => expect(view.queryByText('Loading chart…')).toBeNull());
  expect(preparedRun).not.toHaveBeenCalled();
  await act(async () => { useApp.setState({ manifest: { snapshots: [] } }); });
  expect(preparedRun).toHaveBeenCalledTimes(1);
  await act(async () => { useApp.setState({ manifest: demoManifest }); });
  expect(preparedRun).toHaveBeenCalledTimes(1);
});
