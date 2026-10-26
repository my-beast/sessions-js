import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv from 'ajv';
import { clientTokenFixture, readJson, root, schemaDir } from './fixtures.js';

const validator = (name) => new Ajv({ allErrors: true, strict: false }).compile(readJson(join(schemaDir, name)));

test('the fixture fits the client-token schemas', () => {
    const fixture = clientTokenFixture();
    const claims = validator('client-token.schema.json');
    const header = validator('client-token-header.schema.json');

    assert.ok(claims(fixture.claims), JSON.stringify(claims.errors));
    assert.ok(header(fixture.header), JSON.stringify(header.errors));
});

test('a recording token without its yes does not fit', () => {
    const claims = { ...clientTokenFixture().claims, consent_at: null };
    assert.equal(validator('client-token.schema.json')(claims), false);
});

test("the SDK's schemas are the service's, file for file", (t) => {
    const source = join(root, '..', 'service', 'schemas');
    if (!existsSync(source)) return t.skip('The service is not beside this SDK.');

    const files = (dir) => {
        const out = {};
        const walk = (d) => {
            for (const name of readdirSync(d)) {
                const path = join(d, name);
                if (statSync(path).isDirectory()) walk(path);
                else out[relative(dir, path)] = readFileSync(path, 'utf8');
            }
        };
        walk(dir);
        return out;
    };

    assert.deepEqual(files(join(root, 'schemas')), files(source));
});
