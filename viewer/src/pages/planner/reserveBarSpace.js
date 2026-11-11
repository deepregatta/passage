/** Keeps the document's scroll padding equal to the space a bar pinned to the
 * bottom of the viewport takes (its height plus the distance it keeps from the
 * edge, which on a phone is the bottom navigation), so a focused control is
 * scrolled clear of it. Does nothing while the bar is not displayed.
 * Returns the cleanup. */
export function reserveBarSpace(bar) {
  const root = document.documentElement;
  const update = () => {
    const style = getComputedStyle(bar);
    if (style.display === 'none') {
      root.style.removeProperty('scroll-padding-bottom');
      return;
    }
    const covered = bar.offsetHeight + (parseFloat(style.bottom) || 0);
    root.style.setProperty('scroll-padding-bottom', `${Math.ceil(covered) + 8}px`);
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(bar);
  window.addEventListener('resize', update);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', update);
    root.style.removeProperty('scroll-padding-bottom');
  };
}
