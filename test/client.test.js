import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, mayRecord } from '../src/client.js';
import { clientTokenFixture } from './fixtures.js';

const { token, claims, public_key: key } = clientTokenFixture();

// An unsigned token with other claims: the browser reads, it never verifies (the service does).
const tokenWith = (more) => {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ typ: 'JWT', alg: 'HS256' })}.${part({ ...claims, ...more })}.signature`;
};

test('a page with a recording token may be recorded, masked', () => {
    const client = init({ url: 'https://sessions.example.com/', key, env: 'production', token });

    assert.equal(client.url, 'https://sessions.example.com');
    assert.equal(client.subject, claims.sub);
    assert.equal(client.recording, true);
    assert.equal(client.masked, true);
});

test('no yes, no recording', () => {
    assert.equal(init({ url: 'https://sessions.example.com', key, token: tokenWith({ rec: false }) }).recording, false);
    assert.equal(init({ url: 'https://sessions.example.com', key, token: tokenWith({ consent_at: null }) }).recording, false);
    assert.equal(init({ url: 'https://sessions.example.com', key }).recording, false);
    assert.equal(mayRecord(null), false);
});

test('masking is off only when the token says so', () => {
    assert.equal(init({ url: 'https://sessions.example.com', key, token: tokenWith({ mask: false }) }).masked, false);
    assert.equal(init({ url: 'https://sessions.example.com', key, token: tokenWith({ mask: undefined }) }).masked, true);
});

test('anything malformed switches the SDK off', () => {
    for (const config of [
        null,
        {},
        { url: 'not a url', key },
        { url: 'http://sessions.example.com', key },
        { url: 'https://sessions.example.com', key: 'pk_short' },
        { url: 'ftp://sessions.example.com', key },
    ]) {
        assert.equal(init(config), null, JSON.stringify(config));
    }
});

test('plain http is fine on this machine', () => {
    assert.ok(init({ url: 'http://localhost:8007', key }));
    assert.ok(init({ url: 'http://sessions.test', key }));
});

test('a token of another project is ignored: nothing is recorded', () => {
    const client = init({ url: 'https://sessions.example.com', key: 'pk_' + 'b'.repeat(24), token });

    assert.equal(client.token, null);
    assert.equal(client.subject, null);
    assert.equal(client.recording, false);
});
