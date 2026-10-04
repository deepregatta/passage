/** Generate only decision metadata from the registry; preserve the legacy envelope. */
import { readFileSync, writeFileSync } from 'node:fs';
import { decisionMessageDefinitions } from '../src/briefingMessages.js';

const writerPath = new URL('../../contracts/briefing.schema.json', import.meta.url);
const readerPath = new URL('../../contracts/briefing-reader.schema.json', import.meta.url);
const writer = JSON.parse(readFileSync(writerPath, 'utf8'));
writer.$defs = decisionMessageDefinitions(true);
const reader = structuredClone(writer);
reader.$id = 'https://deepweather.local/contracts/briefing-reader.schema.json';
reader.title = 'Briefing reader envelope (unknown decision IDs retained as English fallback)';
reader.$defs = decisionMessageDefinitions(false);
for (const [path, schema] of [[writerPath, writer], [readerPath, reader]] as const) {
  const content = `${JSON.stringify(schema, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`Message schema drift: ${path.pathname}. Run npm run generate:messages -w engine.`);
  } else writeFileSync(path, content);
}
