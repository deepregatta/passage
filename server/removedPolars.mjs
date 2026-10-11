// Polar files were removed from this site on 2026-10-11 (deep-polars
// decisions 2 and 7). Pages runs Functions before static serving, so these
// routes keep a copy cached at the edge before the removal from ever being
// served again (docs/boat-polars.md).
export function removedPolarFile() {
  return new Response('Removed: boat polars are not published here.\n', {
    status: 410,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
