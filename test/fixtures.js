import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const schemaDir = join(root, 'schemas', 'v1');
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const clientTokenFixture = () => readJson(join(schemaDir, 'fixtures', 'client-token.json'));
