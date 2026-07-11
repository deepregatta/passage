/**
 * @deepweather/engine — per-user analysis engine.
 *
 * Browser-safe core: no DOM, no Node APIs outside src/io/ and src/cli.ts.
 * Everything route-independent, authenticated, or gridded lives in the Python
 * `analysis/` package instead; this engine consumes its prepared artifacts.
 */

export const ENGINE_VERSION = '0.1.0';
