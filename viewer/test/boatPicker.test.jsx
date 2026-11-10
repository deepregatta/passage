import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Invented entries only: no polar data is ever in this repository.
const INDEX = { polars: [
  { polar_id: 'test-boat-a', label: 'Test Boat A', kind: 'type', loa_m: 10.1, builder: 'Invented Yachts', year: 2020, source: 'orc' },
  { polar_id: 'test-boat-b', label: 'Test Boat B', kind: 'type', aliases: ['TB B'] },
  { polar_id: 'generic-10m', label: 'Generic cruiser 10 m', kind: 'generic' },
] };

let BoatPicker;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => INDEX })));
  BoatPicker = (await import('../src/components/BoatPicker.jsx')).default;
});
afterEach(() => vi.unstubAllGlobals());

function Harness({ initial = {} }) {
  const [boat, setBoat] = useState(initial);
  return <BoatPicker polarId={boat.polar_id ?? null} polarLabel={boat.label ?? null} onSelect={setBoat} />;
}
const trigger = () => screen.getByRole('button', { name: /^Your boat \(polar\)/ });

it('prompts for a boat when none is chosen, with a button that is named, 44px tall and says Search', () => {
  render(<Harness />);
  expect(trigger()).toHaveAccessibleName('Your boat (polar) Choose your boat…');
  expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
  expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  expect(trigger()).toHaveClass('min-h-11');
  expect(trigger()).toHaveTextContent('Search');
  expect(trigger()).not.toHaveTextContent('▾');
  // the Search/Change word is decoration: the name is the label and the boat only
  expect(screen.getByText('Search')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByText('Your boat (polar)')).toHaveClass('text-xs!');
});

it('names the chosen boat and offers Change', () => {
  render(<Harness initial={{ polar_id: 'test-boat-a', label: 'Test Boat A' }} />);
  expect(trigger()).toHaveAccessibleName('Your boat (polar) Test Boat A');
  expect(trigger()).toHaveTextContent('Change');
});

it('searches, shows 44px rows with 12px details and a 16px search field, and selects with focus back on the button', async () => {
  render(<Harness />);
  fireEvent.click(trigger());
  expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  const search = await screen.findByRole('textbox', { name: 'Search boat models' });
  expect(search).toHaveClass('text-base', 'min-h-11');
  fireEvent.change(search, { target: { value: 'test boat' } });
  const option = await screen.findByRole('option', { name: /Test Boat A/ });
  expect(option).toHaveClass('min-h-11');
  expect(option.querySelector('.font-mono')).toHaveClass('text-[12px]');
  fireEvent.click(option);
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(trigger()).toHaveAccessibleName('Your boat (polar) Test Boat A');
  expect(trigger()).toHaveFocus();
});

it('closes on Escape and returns focus to the button', async () => {
  render(<Harness />);
  fireEvent.click(trigger());
  const search = await screen.findByRole('textbox', { name: 'Search boat models' });
  await waitFor(() => expect(search).toHaveFocus());
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: 'Search boat models' })).not.toBeInTheDocument();
  expect(trigger()).toHaveFocus();
});
