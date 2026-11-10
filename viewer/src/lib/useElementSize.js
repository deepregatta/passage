import { useCallback, useEffect, useState } from 'react';

/** Track an element's content size. Returns `[ref, size]`; size is null until
 * the element has a real layout box (and always in jsdom). Follows container
 * resizes, window resizes and orientation changes. */
export function useElementSize() {
  const [node, setNode] = useState(null);
  const [size, setSize] = useState(null);
  const ref = useCallback((element) => setNode(element), []);

  useEffect(() => {
    if (!node) return undefined;
    const read = () => {
      const box = node.getBoundingClientRect();
      const next = box.width > 0 && box.height > 0 ? { w: box.width, h: box.height } : null;
      setSize((prev) => (prev && next && Math.abs(prev.w - next.w) < 0.5 && Math.abs(prev.h - next.h) < 0.5 ? prev : next));
    };
    read();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null;
    observer?.observe(node);
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
    };
  }, [node]);

  return [ref, size];
}
