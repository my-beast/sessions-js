import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClaims, secondsLeft } from '../src/token.js';
import { clientTokenFixture } from './fixtures.js';

test('reads the fixture token back into its claims', () => {
    const fixture = clientTokenFixture();
    assert.deepEqual(readClaims(fixture.token), fixture.claims);
});

test('says how long a token has left', () => {
    const { token, claims } = clientTokenFixture();
    assert.equal(secondsLeft(token, (claims.exp - 90) * 1000), 90);
    assert.equal(secondsLeft(token, (claims.exp + 5) * 1000), -5);
});

test('an unreadable token has no claims', () => {
    for (const bad of [null, '', 'a.b', 'a.b.c', 'x.' + btoa('[1]') + '.y', 42]) {
        assert.equal(readClaims(bad), null, String(bad));
        assert.equal(secondsLeft(bad), null, String(bad));
    }
});
