import { Component } from 'react';
import { evidenceCouldNotRender } from '../lib/pageErrors.js';

/**
 * The Evidence inspector's own boundary, apart from the page's (2026-11-15).
 * The inspector is mounted on every page and its open state and selection
 * survive navigation, so an inspector that throws (an evidence record it
 * cannot show, or its code failing to load) inside the page boundary would
 * replace every page with the page's error message.
 *
 * Here the page underneath stays as it is. The inspector is closed and its
 * selection cleared (`onError`), so it cannot throw again on the next render,
 * and one short note says the detail could not be shown. The remembered open
 * check is kept: the check itself rendered. The note goes when the sailor
 * closes it, opens the inspector again or goes to another page.
 */
export default class InspectorErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    evidenceCouldNotRender(error, info?.componentStack);
    try {
      this.props.onError();
    } catch {
      // the note still shows; the inspector stays unmounted while it does
    }
  }

  componentDidUpdate(prevProps, prevState) {
    // Clearing the selection right after the error changes neither of these, so the note stays.
    const reopened = this.props.open && !prevProps.open;
    if (this.state.error && prevState.error && (reopened || prevProps.page !== this.props.page)) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="status" className="fixed right-3 bottom-20 md:bottom-4 z-50 max-w-[calc(100vw-1.5rem)] flex items-center gap-2 bg-paper border border-ink/40 shadow-panel rounded-sm pl-3 pr-1 py-1 font-sans text-sm text-ink">
        <span>This evidence detail could not be shown.</span>
        <button type="button" onClick={() => this.setState({ error: null })} className="min-h-11 min-w-11 px-2 text-ink-soft hover:text-ink">
          Close
        </button>
      </div>
    );
  }
}
