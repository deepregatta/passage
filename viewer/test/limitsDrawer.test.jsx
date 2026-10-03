import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
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
  fireEvent.change(screen.getByLabelText(/Max gusts/), { target: { value: '23' } });
  expect(useApp.getState().limits.night_ok).toBe(night_ok);
  expect(JSON.parse(localStorage.getItem('deepweather.profile-draft'))).toMatchObject({ night_ok, max_gust_kt: 23 });
});

it('explains the inactive preference in English and French', () => {
  expect(translateText(disclosure, 'en')).toBe(disclosure);
  expect(translateText(disclosure, 'fr')).toBe('La préférence de navigation de nuit n’est pas évaluée. Elle ne modifie ni le verdict, ni la comparaison des départs, ni les horaires de la route.');
});
