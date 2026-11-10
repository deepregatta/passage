import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SectionNav, { revealTab, scrollToSection } from '../src/pages/briefing/SectionNav.jsx';
import { Term, tooltipShift } from '../src/lib/glossary.jsx';
import Example from '../src/pages/Example.jsx';
import { useApp } from '../src/stores/appStore.js';
import savedFindings from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/findings.json';
import savedBriefing from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/briefing.json';
import savedRoute from './fixtures/demo/snapshots/20260720T060000Z_44d2cd5f_64ea971e/route.json';

vi.mock('../src/components/lazy/EChartsLazy.jsx', () => ({ default: () => null }));
vi.mock('../src/components/lazy/LeafletLazy.jsx', () => ({ default: () => <div data-testid="passage-map" /> }));

afterEach(cleanup);

describe('revealTab', () => {
  const bar = (scrollLeft) => ({ scrollLeft, clientWidth: 300, scrollWidth: 560, scrollTo: vi.fn() });
  it('scrolls a cut-off last tab into view, horizontally only', () => {
    const b = bar(0);
    revealTab(b, { offsetLeft: 450, offsetWidth: 110 });
    expect(b.scrollTo).toHaveBeenCalledWith({ left: 260, behavior: 'auto' }); // clamped to scrollWidth - clientWidth
  });
  it('leaves a tab alone when it is fully visible clear of the fades', () => {
    const b = bar(0);
    revealTab(b, { offsetLeft: 100, offsetWidth: 80 });
    expect(b.scrollTo).not.toHaveBeenCalled();
  });
  it('brings back a tab hidden to the left', () => {
    const b = bar(260);
    revealTab(b, { offsetLeft: 0, offsetWidth: 60 });
    expect(b.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'auto' });
  });
});

describe('SectionNav', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  it('is opaque, keeps 44px tabs, scrolls the active tab into view and hints the overflow', () => {
    const { container } = render(<SectionNav />);
    const nav = container.querySelector('nav');
    expect(nav.className).toMatch(/\bbg-paper\b/);
    expect(nav.className).not.toMatch(/bg-paper\//);
    const bar = screen.getByTestId('section-tabs');
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(bar, 'scrollWidth', { configurable: true, value: 560 });
    const last = screen.getByRole('button', { name: 'How it turned out' });
    expect(last.className).toMatch(/\bmin-h-11\b/);
    Object.defineProperty(last, 'offsetLeft', { configurable: true, value: 450 });
    Object.defineProperty(last, 'offsetWidth', { configurable: true, value: 110 });
    bar.scrollTo = vi.fn(({ left }) => { bar.scrollLeft = left; });
    fireEvent.click(last);
    expect(last).toHaveAttribute('aria-current', 'location');
    expect(bar.scrollTo).toHaveBeenCalled();
    expect(bar.scrollLeft).toBe(260);
    fireEvent.scroll(bar);
    expect(screen.getByTestId('tabs-fade-start')).toBeInTheDocument();
  });
  it('keeps the clicked tab highlighted while the page scrolls past other sections', () => {
    vi.useFakeTimers();
    try {
      const tops = { story: 0, route: 400, evidence: 800, changes: 1200, outcome: 1600 };
      for (const id of Object.keys(tops)) {
        const section = document.createElement('section');
        section.dataset.section = id;
        document.body.appendChild(section);
      }
      let scrollY = 0;
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
      document.querySelectorAll('[data-section]').forEach((el) => {
        el.getBoundingClientRect = () => ({ top: tops[el.dataset.section] - scrollY });
      });
      render(<SectionNav />);
      act(() => { scrollToSection('evidence'); });
      scrollY = 300; // mid-flight: only the first sections have passed under the bars
      act(() => { window.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(20); });
      expect(screen.getByRole('button', { name: 'Evidence' })).toHaveAttribute('aria-current', 'location');
      scrollY = 800 - 112; // landed where scroll-mt-28 puts it
      act(() => { window.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(400); });
      expect(screen.getByRole('button', { name: 'Evidence' })).toHaveAttribute('aria-current', 'location');
      // later, reading on: the highlight follows the section whose top passed the bars
      scrollY = 1200 - 120;
      act(() => { window.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(400); });
      expect(screen.getByRole('button', { name: 'What changed' })).toHaveAttribute('aria-current', 'location');
    } finally {
      vi.useRealTimers();
      delete window.scrollY;
    }
  });
});

describe('Example page headings', () => {
  it('has no heading before the page H1 and no empty headings', () => {
    useApp.setState({
      ...useApp.getInitialState(), loadExample: vi.fn(async () => {}), page: 'example',
      findings: structuredClone(savedFindings), briefing: structuredClone(savedBriefing), route: structuredClone(savedRoute),
    }, true);
    const { container } = render(<Example />);
    const headings = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    expect(headings[0].tagName).toBe('H1');
    expect(headings.filter((h) => !h.textContent.trim())).toEqual([]);
    expect(screen.getByLabelText('Example briefing')).toHaveTextContent('Synthetic / emulated example');
  });
});

describe('glossary tooltip', () => {
  it('shifts a tooltip left when the term is near the right edge', () => {
    expect(tooltipShift(300, 375)).toBe(375 - 8 - 256 - 300); // right edge at 367
    expect(tooltipShift(20, 375)).toBe(0);
    expect(tooltipShift(2, 375)).toBe(6); // not past the left margin either
    expect(tooltipShift(200, 320)).toBe(320 - 8 - 256 - 200); // 56 px left of the term
    expect(tooltipShift(250, 240)).toBe(8 - 250); // narrower than the tooltip: it shrinks to fit
  });
  it('measures the term when it is hovered or focused', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 375 });
    render(<p><Term term="gust">Gust</Term></p>);
    const button = screen.getByRole('button', { name: 'Gust' });
    button.parentElement.getBoundingClientRect = () => ({ left: 300 });
    fireEvent.focus(button);
    expect(screen.getByRole('tooltip').style.left).toBe(`${375 - 8 - 256 - 300}px`);
  });
});
