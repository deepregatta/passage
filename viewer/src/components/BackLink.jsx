import { pageHash } from '../lib/routes.js';
import { useApp } from '../stores/appStore.js';

/** A plain text link back to one of the two places (Plan or My passages) from a
 * page that is not itself in the navigation. Real anchor, so a new-tab click
 * works; a normal click goes through the router like the navigation does. */
function BackLink({ page, children }) {
  const setPage = useApp((state) => state.setPage);
  return (
    <a
      href={`#${pageHash(page)}`}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        setPage(page);
        window.scrollTo({ top: 0, left: 0 });
      }}
      className="inline-flex min-h-11 items-center gap-1.5 font-instrument text-sm text-ink-soft underline-offset-4 hover:text-event hover:underline print:hidden"
    >
      <span aria-hidden="true">←</span>
      {children}
    </a>
  );
}

export const PlanBackLink = ({ children }) => <BackLink page="planner">{children}</BackLink>;
export const PassagesBackLink = ({ children }) => <BackLink page="passages">{children}</BackLink>;

