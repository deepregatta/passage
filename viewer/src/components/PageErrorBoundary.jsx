import { Component, useEffect, useRef } from 'react';
import { fallbackCouldNotRender, isChunkLoadError, pageCouldNotLoad, pageCouldNotRender, reloadPage } from '../lib/pageErrors.js';

/**
 * Contains an error while rendering the routed page to the page area: the
 * header, navigation, limits and footer outside it stay usable (2026-11-15).
 *
 * On an error it logs with console.error and forgets the check this tab
 * remembers having open (lib/pageErrors.js), so a reload does not reopen the
 * check that could not be shown. Nothing is reported anywhere else, and no
 * saved check is touched. A page whose code could not be loaded (offline, or
 * a chunk an earlier deploy removed; `isChunkLoadError`) is not damaged check
 * content: it says to check the connection and reload, and keeps the
 * remembered check so that reload reopens it. React.lazy keeps the failed
 * import, so only a full reload fetches that page's code again.
 *
 * It shows the page again when `resetKey` changes after the error (another
 * page, a navigation, a different check), which its own button also makes. A key that
 * changes in the same update as the error does not reset it, and a fallback
 * that fails itself leaves the page area empty, so it can never loop.
 */
export default class PageErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (isChunkLoadError(error)) pageCouldNotLoad(error);
    else pageCouldNotRender(error, info?.componentStack);
  }

  componentDidUpdate(prevProps, prevState) {
    if (this.state.error && prevState.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const Fallback = this.props.Fallback ?? (isChunkLoadError(this.state.error) ? PageNotLoadedFallback : PageErrorFallback);
    // The navigation changes resetKey, which shows the page again: one reset, even
    // when the page that failed is My passages itself.
    const leave = () => this.props.onNavigate('passages');
    return <FallbackGuard><Fallback onLeave={leave} /></FallbackGuard>;
  }
}

/** The fallback's own guard: if the fallback fails, the page area stays empty. */
class FallbackGuard extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    fallbackCouldNotRender(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The heading takes keyboard focus when the message appears. */
function FallbackHeading({ children }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <h1 ref={heading} tabIndex={-1} className="font-chart text-3xl focus:outline-hidden">{children}</h1>;
}

function PageErrorFallback({ onLeave }) {
  return (
    <div data-testid="page-error" role="alert" className="px-4 sm:px-6 py-8 max-w-3xl">
      <FallbackHeading>This page could not be shown.</FallbackHeading>
      <p className="font-sans text-sm text-ink-soft mt-2">Something in it could not be displayed. Your saved checks have not been changed.</p>
      <button type="button" onClick={onLeave} className="mt-5 min-h-11 bg-ink text-paper rounded-sm px-4 font-medium hover:bg-ink-deep">
        Go to My passages
      </button>
    </div>
  );
}

function PageNotLoadedFallback() {
  return (
    <div data-testid="page-not-loaded" role="alert" className="px-4 sm:px-6 py-8 max-w-3xl">
      <FallbackHeading>This page could not be loaded.</FallbackHeading>
      <p className="font-sans text-sm text-ink-soft mt-2">Check your connection, then reload the page.</p>
      <button type="button" onClick={reloadPage} className="mt-5 min-h-11 bg-ink text-paper rounded-sm px-4 font-medium hover:bg-ink-deep">
        Reload the page
      </button>
    </div>
  );
}
