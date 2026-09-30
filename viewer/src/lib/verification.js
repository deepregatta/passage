/** Verification documents are optional: a missing or unreadable file means
 * "not verified yet", never an error on the page. */
export async function loadJson(url, signal) {
  try {
    const res = await fetch(url, { signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
