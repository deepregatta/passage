import { canonicalJson } from '@deepweather/engine';
import { polarContentFindings } from '../../../scripts/polar-content-rules.mjs';

// The no-polar-data safety net for check files, shared by the export
// (lib/checkFile.js) and the import (lib/checkImport.js). It is a safety net,
// not a guarantee: it runs the content rules of scripts/check-no-polar-data.mjs
// over the raw texts, over each parsed file's canonical JSON (which decodes
// escaped keys such as "speeds_kt"), and over every string value of at
// least POLAR_STRING_MIN characters inside the parsed files (polar text nested
// inside a JSON string). Anything it does not recognise passes.

export const POLAR_STRING_MIN = 16;

/** True when any rule matches the texts, the values' canonical JSON or a long string inside them. */
export function holdsPolarData({ texts = [], values = [] }) {
  const matches = (text) => polarContentFindings(text).length > 0;
  if (texts.some(matches)) return true;
  for (const value of values) {
    if (matches(canonicalJson(value))) return true;
    const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === 'string') {
        if (item.length >= POLAR_STRING_MIN && matches(item)) return true;
      } else if (item && typeof item === 'object') {
        for (const child of Object.values(item)) pending.push(child);
      }
    }
  }
  return false;
}
