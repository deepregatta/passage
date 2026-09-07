/* Feedback form vendored from coachregatta viewer2/src/components/ui/FeedbackModal.jsx, 2026-07-17.
 * Adapted for Passage: posts to the fleet-wide feedback inbox on
 * oscar.deepregatta.com (contract: oscar viewer2/functions/api/feedback.js),
 * paper-chart styling, English-as-key i18n. No account required. */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useApp } from '../stores/appStore.js';
import { track } from '../lib/analytics.js';

const FEEDBACK_ENDPOINT = 'https://oscar.deepregatta.com/api/feedback';
const CONTACT_EMAIL = 'contact@deepregatta.com';

// The shared inbox accepts race_request; keep its wire category until the API changes.
const CATEGORIES = [
  ['race_request', 'Request a race'],
  ['bug', 'Report a data issue'],
  ['feedback', 'Other feedback'],
];

function deviceType() {
  return window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop';
}

/** One next step after a successful action: keep or reuse the planning context. */
function NextStep({ onNavigate, onDone }) {
  const snapshotId = useApp((state) => state.snapshotId);
  const target = snapshotId ? 'snapshots' : 'planner';
  const label = snapshotId
    ? 'Next: save or share this planning context'
    : 'Next: explore another scenario';
  return (
    <button
      type="button"
      onClick={() => {
        onDone?.();
        onNavigate(target);
      }}
      className="font-instrument text-sm text-event underline underline-offset-4 hover:no-underline"
    >
      {label} →
    </button>
  );
}

function FeedbackDialog({ onNavigate, onClose }) {
  const snapshotId = useApp((state) => state.snapshotId);
  const route = useApp((state) => state.route);
  const language = useApp((state) => state.language);
  const [category, setCategory] = useState('race_request');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canSubmit = message.trim().length > 0 && status !== 'submitting';

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setStatus('submitting');
    try {
      const response = await fetch(FEEDBACK_ENDPOINT, {
        body: JSON.stringify({
          category,
          locale: language || null,
          message: message.trim(),
          page_url: window.location.href,
          platform: deviceType(),
          // Shared inbox wire keys: Passage supplies the snapshot id and route name.
          race_id: snapshotId || null,
          race_name: route?.name || null,
          website,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      setStatus(response.ok ? 'success' : 'error');
    } catch {
      setStatus('error');
    }
  }

  // No portal: the dialog must stay inside #root so LocalizedDocument's
  // MutationObserver keeps translating it.
  return (
    <div
      className="fixed inset-0 z-[3000] flex items-center justify-center bg-ink-deep/60 px-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Request a race or report an issue"
    >
      <div className="w-full max-w-md border border-ink bg-paper p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b hairline pb-3">
          <h2 className="font-instrument text-lg font-semibold text-ink">
            Request a race or report an issue
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-9 min-w-9 font-mono text-sm text-ink-soft hover:text-ink"
          >
            ✕
          </button>
        </div>

        {status === 'success' ? (
          <div className="space-y-4 py-6 text-center font-instrument">
            <p className="text-ink">Thanks! Your message has been received.</p>
            <p>
              <NextStep onNavigate={onNavigate} onDone={onClose} />
            </p>
            <button
              type="button"
              onClick={onClose}
              className="border border-ink/40 px-4 py-1.5 text-sm text-ink-soft hover:border-ink hover:text-ink"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategory(id)}
                  className={clsx(
                    'border px-3 py-1 font-instrument text-sm transition-colors',
                    category === id
                      ? 'border-event text-event'
                      : 'border-ink/30 text-ink-soft hover:border-ink hover:text-ink',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={2000}
              rows={5}
              autoFocus
              placeholder="Which race or passage should we cover, or what looks wrong?"
              className="w-full resize-none border border-ink/30 bg-paper px-3 py-2 font-instrument text-sm text-ink placeholder:text-ink-soft/70 focus:border-event focus:outline-none"
            />
            <input
              type="text"
              name="website"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
            />
            {status === 'error' && (
              <p className="font-instrument text-sm text-event">
                Something went wrong. Please try again or email{' '}
                <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
                  {CONTACT_EMAIL}
                </a>
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <span className="font-instrument text-xs text-ink-soft">No account needed.</span>
              <button
                type="submit"
                disabled={!canSubmit}
                className="border border-event px-5 py-1.5 font-instrument text-sm text-event transition-colors hover:bg-event/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {status === 'submitting' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** Share + feedback actions for the site footer, on every Passage view. */
export default function FooterActions({ onNavigate }) {
  const [copied, setCopied] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  async function share() {
    track('share_click', { surface: 'footer' });
    try {
      await navigator.clipboard.writeText(`${document.title}\n${window.location.href}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 6000);
    } catch {
      // clipboard unavailable; nothing else to do
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <button
        type="button"
        onClick={share}
        className="font-instrument text-sm text-event underline-offset-4 hover:underline"
      >
        {copied ? 'Link copied' : 'Share this analysis'}
      </button>
      <button
        type="button"
        onClick={() => setFeedbackOpen(true)}
        className="font-instrument text-sm text-event underline-offset-4 hover:underline"
      >
        Request a race / report a data issue
      </button>
      {copied && <NextStep onNavigate={onNavigate} />}
      {feedbackOpen && (
        <FeedbackDialog onNavigate={onNavigate} onClose={() => setFeedbackOpen(false)} />
      )}
    </div>
  );
}
