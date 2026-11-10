import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MapContainer, useMap } from 'react-leaflet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MapTouchScroll from '../src/components/MapTouchScroll.jsx';
import {
  TOUCH_SCROLL_CLASS, applyMapTouchMode, mapTouchMode, oneFingerMovesMap, prefersTouchScroll, readTouchScroll,
} from '../src/lib/mapTouchScroll.js';

const media = (matching) => (query) => ({
  matches: matching.includes(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
});

describe('when one finger moves the map', () => {
  it('treats a coarse primary pointer, or a narrow touch viewport, as a phone', () => {
    expect(prefersTouchScroll({ coarse: true })).toBe(true);
    expect(prefersTouchScroll({ narrow: true, anyCoarse: true })).toBe(true);
    // a narrow desktop window with a mouse, or a wide touch laptop, keeps Leaflet's default
    expect(prefersTouchScroll({ narrow: true })).toBe(false);
    expect(prefersTouchScroll({ anyCoarse: true })).toBe(false);
    expect(prefersTouchScroll()).toBe(false);
  });

  it('reads the media queries and survives a missing matchMedia', () => {
    expect(readTouchScroll(media(['(pointer: coarse)']))).toBe(true);
    expect(readTouchScroll(media(['(max-width: 767px)', '(any-pointer: coarse)']))).toBe(true);
    expect(readTouchScroll(media(['(max-width: 767px)']))).toBe(false);
    expect(readTouchScroll(null)).toBe(false);
  });

  it('gives one finger to the page only on a phone with the toggle off and no drawing', () => {
    expect(mapTouchMode({ touchScroll: false, moveMap: true, suspended: true })).toBe('default');
    expect(mapTouchMode({ touchScroll: true })).toBe('scroll');
    expect(mapTouchMode({ touchScroll: true, moveMap: true })).toBe('move');
    expect(mapTouchMode({ touchScroll: true, moveMap: true, suspended: true })).toBe('suspended');
    expect(['default', 'move', 'suspended'].every(oneFingerMovesMap)).toBe(true);
    expect(oneFingerMovesMap('scroll')).toBe(false);
  });

  it('applies a mode to the map and undoes only its own change', () => {
    const container = document.createElement('div');
    const dragging = { enable: vi.fn(), disable: vi.fn() };
    const map = { getContainer: () => container, dragging };
    applyMapTouchMode(map, 'default');
    expect(dragging.enable).not.toHaveBeenCalled();
    applyMapTouchMode(map, 'scroll');
    expect(dragging.disable).toHaveBeenCalledTimes(1);
    expect(container.classList.contains(TOUCH_SCROLL_CLASS)).toBe(true);
    applyMapTouchMode(map, 'suspended');
    expect(dragging.enable).not.toHaveBeenCalled();
    applyMapTouchMode(map, 'move');
    expect(dragging.enable).toHaveBeenCalledTimes(1);
    applyMapTouchMode(map, 'default');
    expect(dragging.enable).toHaveBeenCalledTimes(2);
    expect(container.classList.contains(TOUCH_SCROLL_CLASS)).toBe(false);
  });
});

describe('MapTouchScroll on a Leaflet map', () => {
  const original = window.matchMedia;
  afterEach(() => { window.matchMedia = original; });

  let leaflet;
  function Grab() {
    const map = useMap();
    useEffect(() => { leaflet = map; }, [map]);
    return null;
  }
  const renderMap = (props) => render(
    <MapContainer center={[48, -3]} zoom={6} style={{ height: 300 }}>
      <Grab />
      <MapTouchScroll {...props} />
    </MapContainer>,
  );

  it('leaves a desktop map exactly as Leaflet configures it', () => {
    renderMap();
    expect(screen.queryByRole('button', { name: 'Move the map' })).toBeNull();
    expect(leaflet.dragging.enabled()).toBe(true);
    expect(leaflet.getContainer().classList.contains(TOUCH_SCROLL_CLASS)).toBe(false);
  });

  it('lets one finger scroll on a phone until Move the map is pressed', () => {
    window.matchMedia = vi.fn(media(['(pointer: coarse)', '(any-pointer: coarse)']));
    renderMap();
    const toggle = screen.getByRole('button', { name: 'Move the map' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Use two fingers to move the map');
    expect(leaflet.dragging.enabled()).toBe(false);
    // the toggle lives in a Leaflet control, so its taps never reach the map
    expect(toggle.closest('.leaflet-control')).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('One finger moves the map. Tap again to scroll the page.');
    expect(leaflet.dragging.enabled()).toBe(true);

    fireEvent.click(toggle);
    expect(leaflet.dragging.enabled()).toBe(false);
  });

  it('hands the pointer to a drawing interaction and re-applies phone scrolling afterwards', () => {
    window.matchMedia = vi.fn(media(['(pointer: coarse)']));
    const view = renderMap({ suspended: true });
    expect(screen.queryByRole('button', { name: 'Move the map' })).toBeNull();
    // the drawer re-enables dragging when it finishes, as GribMap's BoxDrawer does
    act(() => leaflet.dragging.enable());
    view.rerender(
      <MapContainer center={[48, -3]} zoom={6} style={{ height: 300 }}>
        <Grab />
        <MapTouchScroll suspended={false} />
      </MapContainer>,
    );
    expect(screen.getByRole('button', { name: 'Move the map' })).toBeInTheDocument();
    expect(leaflet.dragging.enabled()).toBe(false);
  });
});
