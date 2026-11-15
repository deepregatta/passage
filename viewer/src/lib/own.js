/**
 * `table[key]` only when `key` names one of the table's own entries, else
 * undefined, so the caller's existing fallback applies.
 *
 * Keys read from a check (saved, served or, later, imported) or from browser
 * storage are data the page did not write. A plain lookup answers keys such as
 * "toString", "constructor" or "__proto__" with an inherited function or
 * object, and the page then breaks on it (2026-11-15). A key that is not text
 * or a number is never an entry.
 */
export function own(table, key) {
  if (table == null || (typeof key !== 'string' && typeof key !== 'number')) return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
