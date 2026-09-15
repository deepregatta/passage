import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(HERE, '..', '..', 'contracts');
const CONFIG_DIR = join(HERE, '..', '..', 'config');

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, name), 'utf8'));
}

describe('contracts', () => {
  it('every schema compiles under JSON Schema 2020-12', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const files = readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.schema.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const schema = loadSchema(file);
      expect(() => ajv.compile(schema), `${file} should compile`).not.toThrow();
    }
  });

  for (const [directory, schemaName] of [
    ['routes', 'route'], ['profiles', 'limits-profile'], ['polars', 'polar'],
  ]) {
    const files = readdirSync(join(CONFIG_DIR, directory!)).filter(file => file.endsWith('.json') && file !== 'index.json');
    it(`${directory} corpus is nonempty`, () => expect(files.length).toBeGreaterThan(0));
    for (const file of files) {
      it(`${directory}/${file} validates`, () => {
        const ajv = new Ajv2020({ strict: false });
        addFormats(ajv);
        const validate = ajv.compile(loadSchema(`${schemaName}.schema.json`));
        const value = JSON.parse(readFileSync(join(CONFIG_DIR, directory!, file), 'utf8'));
        expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      });
    }
  }
});
