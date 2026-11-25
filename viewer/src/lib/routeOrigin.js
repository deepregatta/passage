/**
 * Was this route computed by the router (engine/src/routing/isochrone.ts), as its
 * own stored record says? The router writes `mode: 'computed'` and, with it, the
 * request it was given (`provenance.routing_request`); a drawn or GPX-imported
 * route is `mode: 'user'`, an example or file-defined route `mode: 'fixed'`, and
 * neither has a request. A route is called computed only when both are stored:
 * a record with one and not the other, an older check without them, or no route
 * file at all cannot tell, and is never guessed (neither the id prefix
 * `computed-` nor the name's "(computed)" decides: a sailor can type either).
 * The planner saves the route object it checked unchanged as route.json, and a
 * departure comparison saves the per-departure route it routed, so a saved
 * check carries this for itself.
 */
export function isComputedRoute(route) {
  if (!route || typeof route !== 'object') return false;
  const request = route.provenance?.routing_request;
  return route.mode === 'computed' && Boolean(request) && typeof request === 'object' && !Array.isArray(request);
}
