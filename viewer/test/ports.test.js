import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPortsCacheForTests, loadPorts, loadedPorts, portNameAt } from '../src/lib/ports.js';
import { nearestPort } from '../src/lib/portLookup.js';
import data from '../src/data/ports.json';

beforeEach(() => {
  clearPortsCacheForTests();
  vi.resetModules();
});

describe('the bundled list of ports', () => {
  it('is the World Port Index in compact form: [name, lat, lon], in range, to three decimals', () => {
    expect(data.ports.length).toBeGreaterThan(3500);
    for (const [name, lat, lon] of data.ports) {
      expect(typeof name).toBe('string');
      expect(name).toBe(name.trim());
      expect(name).not.toMatch(/\s{2,}/);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      expect(Math.round(lat * 1000) / 1000).toBe(lat);
      expect(Math.round(lon * 1000) / 1000).toBe(lon);
    }
  });

  it.each([
    ['Cherbourg', 49.65, -1.62],
    ['Plymouth', 50.37, -4.14],
    ['Newport', 41.49, -71.33],
    ['New York City', 40.7, -74.02],
    ['Palma de Mallorca', 39.56, 2.64],
    ['Barcelona', 41.35, 2.17],
    ['Brisbane', -27.38, 153.17],
    ['Gladstone', -23.83, 151.26],
  ])('has %s within two nautical miles of its known position', (name, lat, lon) => {
    expect(nearestPort(data.ports, lat, lon, 2)?.name).toBe(name);
  });
});

describe('loading the list', () => {
  it('loads it on demand, once, and then answers from it', async () => {
    expect(loadedPorts()).toBeNull();
    expect(portNameAt(49.65, -1.63)).toBeNull(); // not loaded yet: no name, no error
    const first = loadPorts();
    expect(loadPorts()).toBe(first);
    const list = await first;
    expect(list.length).toBe(data.ports.length);
    expect(loadedPorts()).toBe(list);
    expect(portNameAt(49.66, -1.62)).toBe('Cherbourg');
    expect(portNameAt(50, -3)).toBeNull();
  });

  it('resolves to null when the file cannot be loaded, and tries again next time', async () => {
    vi.doMock('../src/data/ports.json', () => { throw new Error('offline'); });
    const failing = await import('../src/lib/ports.js');
    expect(await failing.loadPorts()).toBeNull();
    expect(failing.loadedPorts()).toBeNull();
    expect(failing.portNameAt(49.65, -1.63)).toBeNull();
    vi.doUnmock('../src/data/ports.json');
    vi.resetModules();
    const recovered = await import('../src/lib/ports.js');
    expect(await recovered.loadPorts()).not.toBeNull();
  });
});
