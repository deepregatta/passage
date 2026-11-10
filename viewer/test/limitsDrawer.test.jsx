import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import LimitsDrawer from '../src/components/LimitsDrawer.jsx';
import { useApp } from '../src/stores/appStore.js';
import { translateText } from '../src/i18n.js';
import defaults from '../../config/profiles/default-limits.json';

const disclosure = 'Night-sailing preference is not evaluated. It does not affect the verdict, departure scan or route timing.';
beforeEach(() => {
  localStorage.clear();
  useApp.setState({ ...useApp.getInitialState(), profileDefaults: defaults }, true);
});

it.each([true, false])('reads and preserves a saved night_ok=%s without presenting it as an enforced limit', (night_ok) => {
  localStorage.setItem('deepweather.profile-draft', JSON.stringify({ ...defaults, night_ok }));
  render(<LimitsDrawer />);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByText(disclosure)).toBeVisible();
  expect(screen.getByLabelText(/Max gusts/)).toHaveValue(defaults.max_gust_kt);
  fireEvent.change(screen.getByLabelText(/Max gusts/), { target: { value: '31' } });
  expect(useApp.getState().limits.night_ok).toBe(night_ok);
  expect(JSON.parse(localStorage.getItem('deepweather.profile-draft'))).toMatchObject({ night_ok, max_gust_kt: 31 });
});

it('explains the inactive preference in English and French', () => {
  expect(translateText(disclosure, 'en')).toBe(disclosure);
  expect(translateText(disclosure, 'fr')).toBe('La préférence de navigation de nuit n’est pas évaluée. Elle ne modifie ni le verdict, ni la comparaison des départs, ni les horaires de la route.');
});

const edit = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const stored = () => JSON.parse(localStorage.getItem('deepweather.profile-draft') ?? 'null');

describe('limit validation', () => {
  it.each([
    ['Max gusts', '0', 'max_gust_kt', /Enter a number above 0/],
    ['Max gusts', '-5', 'max_gust_kt', /Enter a number above 0/],
    ['Max gusts', '', 'max_gust_kt', /Enter a number\./],
    ['Max gusts', '20', 'max_gust_kt', /Gusts cannot be below your highest sustained wind limit/],
    ['Max wave height', '0', 'max_wave_height_m', /Enter a number above 0/],
    ['Max steepness', '-0.01', 'max_steepness', /Enter a number above 0/],
    ['Min visibility', '-1', 'min_visibility_nm', /Enter 0 or more/],
    ['Scenario fraction floor', '0', 'scenario_fraction_floor', /above 0, up to 1/],
    ['Scenario fraction floor', '1.5', 'scenario_fraction_floor', /above 0, up to 1/],
  ])('does not save %s = "%s" and says why next to the field', (label, value, key, message) => {
    render(<LimitsDrawer />);
    const before = useApp.getState().limits[key];
    const input = screen.getByLabelText(label);
    edit(label, value);
    expect(useApp.getState().limits[key]).toBe(before);
    expect(stored()).toBeNull();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue(value === '' ? null : Number(value));
    const alert = document.getElementById(input.getAttribute('aria-describedby').split(' ').at(-1));
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(message);
  });

  it('refuses a sustained limit above the gust limit', () => {
    render(<LimitsDrawer />);
    edit('Max sustained · reach', '40');
    expect(useApp.getState().limits.max_sustained_kt.reach).toBe(defaults.max_sustained_kt.reach);
    expect(screen.getByLabelText('Max sustained · reach')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert', { hidden: false })).toHaveTextContent('Sustained wind cannot be above your gust limit.');
  });

  it.each([
    ['Max gusts', '25', 'max_gust_kt', 25],
    ['Min visibility', '0', 'min_visibility_nm', 0],
    ['Scenario fraction floor', '1', 'scenario_fraction_floor', 1],
    ['Scenario fraction floor', '0.05', 'scenario_fraction_floor', 0.05],
    ['Max steepness', '0.06', 'max_steepness', 0.06],
  ])('saves the valid value %s = %s', (label, value, key, expected) => {
    render(<LimitsDrawer />);
    edit(label, value);
    expect(useApp.getState().limits[key]).toBe(expected);
    expect(stored()[key]).toBe(expected);
    expect(screen.getByLabelText(label)).not.toHaveAttribute('aria-invalid');
  });

  it('keeps the typed text while invalid, clears the message once valid, and reverts on blur', async () => {
    const user = userEvent.setup();
    render(<LimitsDrawer />);
    const input = screen.getByLabelText('Max gusts');
    await user.clear(input);
    await user.type(input, '0');
    expect(input).toHaveValue(0);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.type(input, '.'); // "0." is still invalid and still held
    await user.clear(input);
    await user.type(input, '30');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(useApp.getState().limits.max_gust_kt).toBe(30);
    await user.clear(input);
    await user.type(input, '1');
    expect(useApp.getState().limits.max_gust_kt).toBe(30);
    await user.tab();
    expect(input).toHaveValue(30);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('alert', { hidden: false })).toHaveTextContent('Not saved. Your previous value is kept.');
  });

  it('describes the two settings that need a plain-language explanation', () => {
    render(<LimitsDrawer />);
    for (const [label, text] of [
      ['Max steepness', /Wave height divided by wavelength/],
      ['Scenario fraction floor', /0\.3 means 3 in 10 scenarios/],
    ]) {
      const described = screen.getByLabelText(label).getAttribute('aria-describedby').split(' ').map((id) => document.getElementById(id));
      expect(described.some((node) => text.test(node.textContent))).toBe(true);
    }
  });

  it('translates the new messages and help into French', () => {
    for (const text of [
      'Enter a number.', 'Enter a number above 0.', 'Enter a number above 0, up to 1.', 'Enter 0 or more.',
      'Gusts cannot be below your highest sustained wind limit.', 'Sustained wind cannot be above your gust limit.',
      'Not saved. Your previous value is kept.', 'Wave height divided by wavelength. A short, steep sea is rougher than its height alone suggests.',
    ]) expect(translateText(text, 'fr')).not.toBe(text);
  });
});

describe('limits drawer as a modal', () => {
  it('describes the limits as applying to every future check, not one passage', () => {
    render(<LimitsDrawer />);
    expect(screen.getByText(/apply to every check you make from now on/)).toBeVisible();
    expect(screen.queryByText(/Presets/)).toBeNull();
    expect(screen.getByText('Changes apply to your next check. Briefings you already made keep the limits they were checked against.')).toBeVisible();
  });

  it('locks body scroll while open and restores it on close, and contains overscroll', () => {
    document.body.style.overflow = 'scroll';
    const { unmount } = render(<LimitsDrawer />);
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('dialog')).toHaveClass('overscroll-contain');
    unmount();
    expect(document.body.style.overflow).toBe('scroll');
    document.body.style.overflow = '';
  });

  it('traps focus across every control, closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const opener = <button type="button">Opener</button>;
    const { rerender } = render(opener);
    screen.getByRole('button', { name: 'Opener' }).focus();
    rerender(<>{opener}<LimitsDrawer /></>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    const done = screen.getByRole('button', { name: 'Done' });
    done.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close limits' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(done).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(useApp.getState().limitsOpen).toBe(false);
    rerender(opener);
    expect(screen.getByRole('button', { name: 'Opener' })).toHaveFocus();
  });
});
