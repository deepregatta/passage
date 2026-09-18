import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Shell from '../src/components/Shell.jsx';

it.each([
  ['keyboard', '#brief/story'],
  ['pointer', '#brief/story'],
  ['keyboard', '#brief/story?snapshot=served-analysis'],
  ['pointer', '#brief/story?snapshot=served-analysis'],
  ['keyboard', '#plan/limits'],
  ['pointer', '#plan/limits'],
])('skips by %s without changing %s or adding history', async (activation, hash) => {
  history.replaceState(null, '', `/fr/?utm_source=skip-test${hash}`);
  const url = location.href;
  const historyLength = history.length;
  const onNavigate = vi.fn();
  const user = userEvent.setup();
  render(<Shell page="briefing" onNavigate={onNavigate}><button>Content action</button></Shell>);
  const skip = screen.getByRole('link', { name: 'Skip to briefing content' });

  if (activation === 'keyboard') {
    await user.tab();
    expect(skip).toHaveFocus();
    await user.keyboard('{Enter}');
  } else {
    await user.click(skip);
  }

  expect(screen.getByRole('main')).toHaveFocus();
  expect(location.href).toBe(url);
  expect(history.length).toBe(historyLength);
  expect(onNavigate).not.toHaveBeenCalled();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Content action' })).toHaveFocus();
});
