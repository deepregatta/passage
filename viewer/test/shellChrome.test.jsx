import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Shell from '../src/components/Shell.jsx';
import { useApp } from '../src/stores/appStore.js';
import { translateText } from '../src/i18n.js';
import defaults from '../../config/profiles/default-limits.json';

// Stand in for the fleet campaign decorator so the test sees exactly which links it touches.
vi.mock('../src/lib/analytics.js', () => ({
  withUtm: (href) => `${href}${href.includes('?') ? '&' : '?'}utm_source=first-touch`,
  track: () => {},
  trackOnce: () => {},
}));

beforeEach(() => {
  useApp.setState({ ...useApp.getInitialState(), profileDefaults: defaults, limits: structuredClone(defaults), language: 'en' }, true);
});

const renderShell = () => render(<Shell page="planner" onNavigate={() => {}}><p>Content</p></Shell>);

describe('limits in the header and bottom navigation', () => {
  it('names wind, gusts and waves in the chip text and its accessible name', () => {
    renderShell();
    const chip = screen.getAllByRole('button', { name: /^Edit my limits/ }).find((el) => el.classList.contains('md:flex'));
    expect(chip).toHaveAccessibleName('Edit my limits: wind 18 kt, gusts 28 kt, waves 2.5 m');
    expect(chip).toHaveTextContent('Wind 18 · Gusts 28 kt · Waves 2.5 m');
    expect(chip.querySelector('[title]')).toHaveAttribute('title', 'Strictest sustained wind, gust limit and wave height limit');
  });

  it('shows the current limits under the phone Limits label', () => {
    renderShell();
    const nav = screen.getAllByRole('navigation', { name: 'Main navigation' }).find((el) => el.classList.contains('md:hidden'));
    const button = within(nav).getByRole('button', { name: /^Edit my limits/ });
    expect(button).toHaveTextContent('Limits18/28 kt · 2.5 m');
    expect(button).toHaveClass('min-h-11');
    expect(button.innerHTML).not.toMatch(/text-\[1[01]px\]/);
  });

  it('keeps the plain accessible name while the limits are still loading', () => {
    useApp.setState({ limits: null, profileDefaults: null });
    renderShell();
    expect(screen.getAllByRole('button', { name: 'Edit my limits' }).length).toBe(1);
  });

  it('translates the chip into French', () => {
    // The catalogue's own fragments render knots as "nd" everywhere in French.
    expect(translateText('Wind 18 · Gusts 28 kt', 'fr')).toBe('Vent 18 · Rafales 28 nd');
    expect(translateText(' · Waves 2.5 m', 'fr')).toBe(' · Vagues 2.5 m');
    expect(translateText('Edit my limits: wind 18 kt, gusts 28 kt, waves 2.5 m', 'fr'))
      .toBe('Modifier mes limites : vent 18 nd, rafales 28 nd, vagues 2.5 m');
  });
});

describe('phone header', () => {
  it('is sticky only from the md breakpoint and has 44px tap targets below it', () => {
    renderShell();
    const header = screen.getByRole('banner');
    expect(header.className).toMatch(/\bmd:sticky\b/);
    expect(header.className.split(/\s+/)).not.toContain('sticky');
    for (const control of [screen.getByRole('button', { name: 'Passage home' }), screen.getByRole('button', { name: 'English' }), screen.getByRole('button', { name: 'Français' })]) {
      expect(control).toHaveClass('min-h-11', 'min-w-11');
    }
  });

  it('gives the dark header and bottom navigation a light focus ring', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const rule = css.match(/\.on-dark button:focus-visible,[^{]*\{[^}]*\}/)?.[0] ?? '';
    // covers the cream-filled active language button explicitly and wins over any dark ring
    expect(rule).toContain('.on-dark button[aria-pressed]:focus-visible');
    expect(rule).toMatch(/outline:\s*2px solid theme\('colors\.paper\.DEFAULT'\) !important/);
    expect(rule).toMatch(/outline-offset:\s*2px !important/);
    // outline-color must not fade in from currentColor (ink on the active language button)
    expect(rule).toMatch(/transition-property:\s*color, background-color, border-color;/);
    renderShell();
    const active = screen.getAllByRole('button', { pressed: true }).find((b) => b.getAttribute('lang'));
    expect(active.closest('.on-dark')).not.toBeNull();
    expect(active.className).not.toMatch(/outline-/);
    expect(screen.getByRole('banner')).toHaveClass('on-dark');
    const bottom = screen.getAllByRole('navigation', { name: 'Main navigation' }).find((el) => el.classList.contains('md:hidden'));
    expect(bottom).toHaveClass('on-dark');
  });
});

describe('footer links', () => {
  it('keeps campaign attribution off the internal Privacy link only', () => {
    renderShell();
    const legal = screen.getByRole('navigation', { name: 'DeepRegatta legal and contact links' });
    expect(within(legal).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(within(legal).getByRole('link', { name: 'Terms' }).getAttribute('href')).toContain('utm_source=first-touch');
    expect(within(legal).getByRole('link', { name: 'DeepRegatta' }).getAttribute('href')).toContain('utm_source=first-touch');
  });

  it('gives footer links and the About button a 44px tap height on phones', () => {
    renderShell();
    const legal = screen.getByRole('navigation', { name: 'DeepRegatta legal and contact links' });
    for (const link of within(legal).getAllByRole('link')) expect(link).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: 'About the data' })).toHaveClass('min-h-11');
  });
});
