import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export function walkFiles(root, accept) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(root, entry.name);
      return entry.isDirectory() ? walkFiles(file, accept) : accept(file) ? [file] : [];
    });
}

// Keep all non-empty literals, including technical tokens and existing French.
// Their identity results must be explicit too: no prose-detection regex can hide a leak.
export function jsxLiterals(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  if (tree.parseDiagnostics.length) throw new Error(`Cannot parse ${file}: ${tree.parseDiagnostics[0].messageText}`);
  const samples = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      || ts.isJsxText(node)) {
      let text = node.text;
      if (ts.isJsxText(node) || (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent))) {
        // JSX entities are decoded by React before the DOM localiser sees them.
        const element = document.createElement('textarea');
        element.innerHTML = text;
        text = element.value;
      }
      text = text.trim();
      if (ts.isJsxText(node)) text = text.replace(/\s+/g, ' ');
      if (text) {
        const { line, character } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        samples.push({ text, source: `${file}:${line + 1}:${character + 1}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return samples;
}

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

export function briefingStrings(value, file, pointer = '') {
  if (typeof value === 'string') {
    // Whole values match full-paragraph catalogue patterns. Sentences also catch
    // unchanged prose following a translated sentence. Decimal values stay intact.
    const texts = new Set([value.trim(), ...Array.from(sentences.segment(value), ({ segment }) => segment.trim())]);
    return [...texts].filter(Boolean).map((text) => ({ text, source: `${file}#${pointer}` }));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => briefingStrings(
    child, file, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
  ));
}

export function collectCoverage(repoRoot) {
  const jsx = walkFiles(path.join(repoRoot, 'viewer/src'), (file) => file.endsWith('.jsx'));
  const golden = walkFiles(path.join(repoRoot, 'engine/test/golden'), (file) => /briefing[^/]*\.json$/.test(file));
  const demo = walkFiles(path.join(repoRoot, 'viewer/test/fixtures/demo'), (file) => path.basename(file) === 'briefing.json');
  const relative = (file) => path.relative(repoRoot, file).split(path.sep).join('/');
  const samples = jsx.flatMap((file) => jsxLiterals(readFileSync(file, 'utf8'), relative(file)));
  for (const file of [...golden, ...demo]) {
    samples.push(...briefingStrings(JSON.parse(readFileSync(file, 'utf8')), relative(file)));
  }
  return { jsx, golden, demo, samples };
}

// Exceptions are scoped by file and exact text (never a pattern or a line number).
// Moving a line is harmless; adding the same leak in a different file still fails.
export function identityEntries(samples, translate) {
  const byFile = {};
  for (const { text, source } of samples) {
    if (translate(text, 'fr') !== text) continue;
    const file = source.split(/#|:\d/)[0];
    (byFile[file] ??= new Set()).add(text);
  }
  return Object.fromEntries(Object.keys(byFile).sort().map((file) => [file, [...byFile[file]].sort()]));
}
