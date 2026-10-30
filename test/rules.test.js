// The recorder's pure parts (src/rules.js; ported from Asuvaan's insightsRecording tests): which recording a tab
// writes to, the tail a page leaves for the next one, the marks' payloads, chunks, the upload address and what an
// answer means (schemas/README.md, "Uploading a chunk").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
    CHANNEL,
    CONSENT_SLACK_MS,
    KEYS,
    MAX_CHUNK_CHARS,
    TAIL_MAX_CHARS,
    answerFor,
    authOf,
    chunkUrl,
    consentReached,
    dialogPayload,
    dropTail,
    envPayload,
    errorPayload,
    gzip,
    identityForDocument,
    isDuplicate,
    isUuid,
    limitsOf,
    mintIdentity,
    newId,
    packEvents,
    pagePayload,
    ping,
    pressPayload,
    pushTail,
    readIdentity,
    refusedPayload,
    renewReason,
    replyTo,
    sameHolder,
    scrubEvent,
    splitJson,
    takeTails,
    tailsOf,
    uploadInit,
    visitPayload,
    words,
    writeIdentity,
} from '../src/rules.js';
import { memoryStore, refusing } from './fakes.js';
import { clientTokenFixture } from './fixtures.js';

const MIN = 60_000;
const ID_A = '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e';
const ID_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SUBJECT = 'user-42';
const ACCOUNT = 'acct-7';
const ctx = (now, extra = {}) => ({ now, idleMs: 30 * MIN, maxMs: 120 * MIN, subject: SUBJECT, account: ACCOUNT, ...extra });
const stored = (extra = {}) => ({ id: ID_A, doc: 3, last: 1_000_000, start: 900_000, subject: SUBJECT, account: ACCOUNT, ...extra });

/* ── Which recording ───────────────────────────────────────────────────── */

test('the options give the minutes; a missing or odd value takes 30 / 120', () => {
    assert.deepEqual(limitsOf({ idleMinutes: 5, maxMinutes: 60 }), { idleMs: 5 * MIN, maxMs: 60 * MIN });
    assert.deepEqual(limitsOf({}), { idleMs: 30 * MIN, maxMs: 120 * MIN });
    assert.deepEqual(limitsOf(), { idleMs: 30 * MIN, maxMs: 120 * MIN });
    assert.deepEqual(limitsOf({ idleMinutes: 0, maxMinutes: 'x' }), { idleMs: 30 * MIN, maxMs: 120 * MIN });
    assert.deepEqual(limitsOf({ idleMinutes: -5, maxMinutes: 1e9 }), { idleMs: 30 * MIN, maxMs: 120 * MIN });
});

test('a tab carries on with its recording while nothing says otherwise', () => {
    assert.equal(renewReason(stored(), ctx(1_000_000 + 29 * MIN)), '');
});

test('a new recording: none yet, idle, max, another person, another account', () => {
    assert.equal(renewReason(stored({ id: null }), ctx(1_000_000)), 'new');
    assert.equal(renewReason(stored({ id: 'not-a-uuid' }), ctx(1_000_000)), 'new', 'a tampered id is not sent to the service');
    assert.equal(renewReason(stored(), ctx(1_000_000 + 30 * MIN + 1)), 'idle');
    assert.equal(renewReason(stored({ last: 0 }), ctx(1_000_000)), 'idle', 'no input known');
    assert.equal(renewReason(stored({ last: 900_000 + 119 * MIN }), ctx(900_000 + 120 * MIN + 1)), 'max');
    assert.equal(renewReason(stored({ doc: 65_535 }), ctx(1_000_000)), 'max', "the contract's last document");
    assert.equal(renewReason(stored(), ctx(1_000_000, { subject: 'user-43' })), 'subject');
    assert.equal(renewReason(stored(), ctx(1_000_000, { account: 'acct-8' })), 'account');
    assert.equal(renewReason(stored({ account: '' }), ctx(1_000_000)), 'account', 'an account appeared');
    assert.equal(renewReason(stored(), ctx(1_000_000, { account: '' })), 'account', 'the account went');
});

test('the idle rule counts from the last input, the max rule from the start', () => {
    // Active all along (input a minute ago), but two hours and a minute since the start: a new one.
    assert.equal(renewReason(stored({ start: 1, last: 121 * MIN }), ctx(121 * MIN + 1)), 'max');
    // A clock set back (now before the last input) is not idle.
    assert.equal(renewReason(stored(), ctx(999_000)), '');
});

test('a full page load goes on as the next document, or a new recording begins at document 1', () => {
    const next = identityForDocument(stored(), ctx(1_000_000 + MIN), () => ID_B);
    assert.equal(next.reason, '');
    assert.deepEqual(next.identity, stored({ doc: 4 }));

    const fresh = identityForDocument(stored(), ctx(1_000_000 + 31 * MIN), () => ID_B);
    assert.equal(fresh.reason, 'idle');
    assert.deepEqual(fresh.identity, { id: ID_B, doc: 1, last: 1_000_000 + 31 * MIN, start: 1_000_000 + 31 * MIN, subject: SUBJECT, account: ACCOUNT });

    const other = identityForDocument(stored(), ctx(1_000_000 + MIN, { subject: 'user-43' }), () => ID_B);
    assert.equal(other.reason, 'subject');
    assert.equal(other.identity.id, ID_B);
    assert.equal(other.identity.subject, 'user-43');
});

test('mint: document 1, started and touched now, for this person and account', () => {
    assert.deepEqual(mintIdentity(ctx(5000, { account: '' }), () => ID_A), { id: ID_A, doc: 1, last: 5000, start: 5000, subject: SUBJECT, account: '' });
});

test('the identity survives a reload: written and read back under the mybeast-rec- keys', () => {
    const store = memoryStore();
    assert.equal(writeIdentity(store, stored()), true);
    assert.equal(store.items.get('mybeast-rec-id'), ID_A);
    assert.equal(store.items.get('mybeast-rec-doc'), '3');
    assert.equal(store.items.get('mybeast-rec-last'), '1000000');
    assert.equal(store.items.get('mybeast-rec-subject'), SUBJECT);
    assert.equal(store.items.get('mybeast-rec-account'), ACCOUNT);
    assert.deepEqual(readIdentity(store), stored());
    assert.ok(Object.values(KEYS).every((key) => key.startsWith('mybeast-rec-')));
    assert.equal(CHANNEL, 'mybeast-rec');
});

test('a refused or empty storage reads as nothing stored, and a new recording begins', () => {
    const nothing = { id: null, doc: 0, last: 0, start: 0, subject: '', account: '' };
    assert.deepEqual(readIdentity(refusing), nothing);
    assert.deepEqual(readIdentity(null), nothing);
    assert.equal(writeIdentity(refusing, stored()), false);
    assert.equal(writeIdentity(null, stored()), false);
    assert.equal(renewReason(readIdentity(memoryStore()), ctx(1)), 'new');
    assert.deepEqual(readIdentity(memoryStore({ [KEYS.doc]: 'x', [KEYS.last]: '-4' })).doc, 0);
});

test('ids are UUIDs, with or without crypto.randomUUID', () => {
    assert.ok(isUuid(newId()));
    let n = 0;
    const noRandomUuid = { getRandomValues: (bytes) => { bytes.forEach((_, i) => { bytes[i] = (n++ * 37) & 0xff; }); return bytes; } };
    const id = newId(noRandomUuid);
    assert.ok(isUuid(id), id);
    assert.equal(id[14], '4', 'version 4');
    assert.ok('89ab'.includes(id[19]), 'RFC 4122 variant');
    assert.notEqual(newId(), newId());
});

test('duplicated tabs: a tab answers a ping on its own id only, and the pinging tab renews within 10 s', () => {
    assert.deepEqual(ping(ID_A), { kind: 'ping', id: ID_A });
    assert.deepEqual(replyTo(ping(ID_A), ID_A), { kind: 'same', id: ID_A });
    assert.equal(replyTo(ping(ID_B), ID_A), null, 'another recording: no answer');
    assert.equal(replyTo({ kind: 'same', id: ID_A }, ID_A), null, 'answers are not answered');
    assert.equal(replyTo(ping('junk'), 'junk'), null);
    assert.equal(replyTo(null, ID_A), null);

    assert.equal(isDuplicate({ kind: 'same', id: ID_A }, ID_A, 1000, 1500), true);
    assert.equal(isDuplicate({ kind: 'same', id: ID_A }, ID_A, 1000, 11_001), false, 'too late: not about our ping');
    assert.equal(isDuplicate({ kind: 'same', id: ID_A }, ID_A, 0, 10), false, 'we never pinged');
    assert.equal(isDuplicate({ kind: 'same', id: ID_B }, ID_A, 1000, 1500), false);
    assert.equal(isDuplicate(ping(ID_A), ID_A, 1000, 1500), false);
});

/* ── The token ─────────────────────────────────────────────────────────── */

const { token, claims, public_key: key } = clientTokenFixture();
const tokenWith = (more) => {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ typ: 'JWT', alg: 'HS256' })}.${part({ ...claims, ...more })}.signature`;
};

test("a token says who, which account, whether and how - read the way init() reads it", () => {
    assert.deepEqual(authOf(key, token), {
        token, subject: claims.sub, account: claims.acct, recording: true, masked: true, consentAt: claims.consent_at,
    });
    assert.equal(authOf(key, tokenWith({ acct: null })).account, '');
    assert.equal(authOf(key, tokenWith({ mask: false })).masked, false);
    assert.equal(authOf(key, tokenWith({ rec: false })).recording, false);
});

test('no token, an unreadable one or one of another project is no token: nothing is recorded, masked', () => {
    for (const bad of [null, '', 'a.b.c', 42, tokenWith({ iss: 'pk_' + 'b'.repeat(24) })]) {
        const auth = authOf(key, bad);
        assert.equal(auth.token, null, String(bad));
        assert.equal(auth.recording, false);
        assert.equal(auth.masked, true);
        assert.equal(auth.subject, '');
    }
});

test("a browser whose clock is behind the yes waits for it (the service refuses events from >5 s before)", () => {
    const auth = { consentAt: 1_000_000 };
    assert.equal(consentReached(auth, 1_000_000 - CONSENT_SLACK_MS - 1), false);
    assert.equal(consentReached(auth, 1_000_000 - CONSENT_SLACK_MS), true);
    assert.ok(CONSENT_SLACK_MS < 5000, 'inside the service tolerance');
    assert.equal(consentReached({ consentAt: 0 }, 1), true);
});

test('a chunk is filed under the same person, account and masking only', () => {
    const holder = { subject: SUBJECT, account: ACCOUNT, masked: true };
    assert.equal(sameHolder(holder, { ...holder }), true);
    assert.equal(sameHolder(holder, { ...holder, subject: 'user-43' }), false);
    assert.equal(sameHolder(holder, { ...holder, account: '' }), false);
    assert.equal(sameHolder(holder, { ...holder, masked: false }), false);
    assert.equal(sameHolder({ ...holder, subject: '' }, { ...holder, subject: '' }), false, 'nobody is no one to file under');
});

/* ── The tail ──────────────────────────────────────────────────────────── */

const chunk = (seq, json = '[{"type":4}]', id = ID_A, doc = 2, subject = SUBJECT) => ({ id, doc, seq, json, subject, account: ACCOUNT, masked: true });

test("a page sends only its own holder's leftovers: never another person's, never an untagged one", () => {
    const store = memoryStore();
    pushTail(store, chunk(0));
    pushTail(store, chunk(1, '[{"type":3}]', ID_A, 2, 'someone-else'));
    pushTail(store, { id: ID_B, doc: 1, seq: 0, json: '[]' });
    pushTail(store, { ...chunk(2), masked: false });
    const holder = { subject: SUBJECT, account: ACCOUNT, masked: true };
    assert.deepEqual(tailsOf(takeTails(store), holder), [chunk(0)]);
    assert.deepEqual(tailsOf([chunk(0)], { subject: '', account: ACCOUNT, masked: true }), [], 'nobody signed in: nothing');
});

test('a chunk left in the tab is taken by the next page, once; its token never goes in the tab', () => {
    const store = memoryStore();
    assert.equal(pushTail(store, { ...chunk(0), token: 'secret.token.value' }), true);
    assert.equal(pushTail(store, chunk(1, '[{"type":3}]')), true);
    assert.equal(pushTail(store, chunk(1, '[{"type":3}]')), true, 'the same chunk twice is kept once');
    assert.ok(!store.items.get(KEYS.tail).includes('secret'), 'the next page sends with its own token');
    assert.deepEqual(takeTails(store), [chunk(0), chunk(1, '[{"type":3}]')]);
    assert.equal(store.items.has(KEYS.tail), false);
    assert.deepEqual(takeTails(store), []);
});

test('a chunk sent another way is taken back out; only the one that took it sends it', () => {
    const store = memoryStore();
    pushTail(store, chunk(0));
    pushTail(store, chunk(1));
    assert.equal(dropTail(store, chunk(0)), true);
    assert.equal(dropTail(store, chunk(0)), false, 'already taken');
    assert.deepEqual(takeTails(store), [chunk(1)]);
    assert.equal(dropTail(store, chunk(1)), false, 'the next page took it: it sends it');
    pushTail(store, chunk(5));
    assert.equal(dropTail(store, chunk(5)), true);
    assert.equal(store.items.has(KEYS.tail), false, 'the last one out removes the key');
});

test('the tail keeps at most TAIL_MAX_CHARS; the oldest go first; one too big is not kept', () => {
    const store = memoryStore();
    const big = (seq) => chunk(seq, `["${'x'.repeat(TAIL_MAX_CHARS / 2 - 10)}"]`);
    assert.equal(pushTail(store, big(0)), true);
    assert.equal(pushTail(store, big(1)), true);
    assert.equal(pushTail(store, big(2)), true);
    assert.deepEqual(takeTails(store).map((t) => t.seq), [1, 2]);
    assert.equal(pushTail(store, chunk(9, `["${'x'.repeat(TAIL_MAX_CHARS)}"]`)), false);
    assert.deepEqual(takeTails(store), []);
});

test('a refused storage keeps nothing and breaks nothing; junk in the key is ignored', () => {
    assert.equal(pushTail(refusing, chunk(0)), false);
    assert.equal(dropTail(refusing, chunk(0)), false);
    assert.deepEqual(takeTails(refusing), []);
    assert.equal(pushTail(null, chunk(0)), false);
    assert.equal(pushTail(memoryStore(), { id: 'nope', doc: 1, seq: 0, json: '[]' }), false);
    const junk = memoryStore({ [KEYS.tail]: '{not json' });
    assert.deepEqual(takeTails(junk), []);
    assert.equal(junk.items.has(KEYS.tail), false, 'junk is cleared');
    const mixed = memoryStore({ [KEYS.tail]: JSON.stringify([chunk(0), { id: ID_A, doc: '1', seq: 0, json: '[]' }, 7]) });
    assert.deepEqual(takeTails(mixed), [chunk(0)]);
});

/* ── What leaves the browser unmasked ──────────────────────────────────── */

/** An rrweb full snapshot of html > body > div#app[data-page] > main, as serialized nodes. */
function fullSnapshot() {
    return {
        type: 2,
        timestamp: 1,
        data: {
            node: {
                type: 0,
                id: 1,
                childNodes: [{
                    type: 2, tagName: 'html', id: 2, attributes: { lang: 'fi', 'data-theme': 'dark' },
                    childNodes: [{
                        type: 2, tagName: 'body', id: 3, attributes: {},
                        childNodes: [{
                            type: 2, tagName: 'div', id: 4, attributes: { id: 'app', 'data-page': '{"props":{"account":{"iban":"FI49"}}}' },
                            childNodes: [{ type: 2, tagName: 'main', id: 5, attributes: { 'data-page': 'x', class: 'p-4' }, childNodes: [{ type: 3, id: 6, textContent: 'Hei' }] }],
                        }],
                    }],
                }],
            },
            initialOffset: { left: 0, top: 0 },
        },
    };
}

test("unmasked: Inertia's data-page leaves a full snapshot (every element), the rest stays as it was", () => {
    const event = fullSnapshot();
    assert.equal(scrubEvent(event), event, 'changed in place');
    const html = event.data.node.childNodes[0];
    const app = html.childNodes[0].childNodes[0];
    assert.deepEqual(app.attributes, { id: 'app' });
    assert.deepEqual(app.childNodes[0].attributes, { class: 'p-4' });
    assert.deepEqual(html.attributes, { lang: 'fi', 'data-theme': 'dark' });
    assert.equal(app.childNodes[0].childNodes[0].textContent, 'Hei');
    assert.equal(JSON.stringify(event).includes('data-page'), false);
});

test('...and added nodes and attribute changes of a mutation; other events pass untouched', () => {
    const mutation = {
        type: 3,
        timestamp: 2,
        data: {
            source: 0,
            texts: [],
            removes: [],
            adds: [{ parentId: 3, nextId: null, node: { type: 2, tagName: 'div', id: 9, attributes: { id: 'app', 'data-page': '{}' }, childNodes: [] } }],
            attributes: [{ id: 4, attributes: { 'data-page': '{"x":1}', class: 'a' } }, { id: 5, attributes: { 'aria-busy': null } }],
        },
    };
    scrubEvent(mutation);
    assert.deepEqual(mutation.data.adds[0].node.attributes, { id: 'app' });
    assert.deepEqual(mutation.data.attributes, [{ id: 4, attributes: { class: 'a' } }, { id: 5, attributes: { 'aria-busy': null } }]);

    const input = { type: 3, timestamp: 3, data: { source: 5, id: 7, text: 'data-page', isChecked: false } };
    assert.deepEqual(scrubEvent(structuredClone(input)), input);
    const custom = { type: 5, timestamp: 4, data: { tag: 'page', payload: { 'data-page': 'kept: a mark is ours' } } };
    assert.deepEqual(scrubEvent(structuredClone(custom)), custom);
    assert.equal(scrubEvent(null), null);
    assert.deepEqual(scrubEvent({ type: 2 }), { type: 2 });
    assert.deepEqual(scrubEvent({ type: 3, data: { source: 0 } }), { type: 3, data: { source: 0 } });
});

/* ── Marks ─────────────────────────────────────────────────────────────── */

test('env: the screen as it was, translated by the browser or not, masked or not, rotated only mid-page', () => {
    const facts = { path: '/properties?view=cards', w: 1440, h: 900, dpr: 2, lang: 'fi', theme: 'dark', className: 'translated-ltr' };
    assert.deepEqual(envPayload(facts, 3), { path: '/properties?view=cards', w: 1440, h: 900, dpr: 2, lang: 'fi', theme: 'dark', translated: true, doc: 3, masked: true });
    assert.equal(envPayload({ ...facts, className: '' }, 1).translated, false);
    assert.equal(envPayload({ ...facts, className: 'untranslated-ltr' }, 1).translated, false);
    assert.equal(envPayload(facts, 1, { rotated: true }).rotated, true);
    assert.equal(envPayload(facts, 1, { masked: false }).masked, false);
    assert.equal('rotated' in envPayload(facts, 1), false);
    assert.deepEqual(envPayload({}, 1), { path: '', w: 0, h: 0, dpr: 1, lang: '', theme: '', translated: false, doc: 1, masked: true });
});

test("page: the host's own name for the page and its address", () => {
    assert.deepEqual(pagePayload('Property/Show', '/properties/5/money'), { name: 'Property/Show', url: '/properties/5/money' });
    assert.deepEqual(pagePayload(null, null), { name: null, url: null });
    assert.deepEqual(pagePayload('', new URL('http://localhost/a?b=1')), { name: null, url: '/a?b=1' });
});

test('visit: method and address from a URL object; the finish says how it ended', () => {
    const url = new URL('http://localhost:8001/tenants?search=Aino#x');
    assert.deepEqual(visitPayload('start', { method: 'post', url }), { phase: 'start', method: 'post', url: '/tenants?search=Aino' });
    assert.deepEqual(visitPayload('finish', { method: 'GET', url, completed: true, cancelled: false }), {
        phase: 'finish', method: 'get', url: '/tenants?search=Aino', completed: true, cancelled: false,
    });
    assert.equal(visitPayload('finish', { method: 'get', url: '/x', interrupted: true }).interrupted, true);
    assert.deepEqual(visitPayload('start', undefined), { phase: 'start', method: 'get', url: '' });
});

test('refused: the refused fields (at most 20) and the first message', () => {
    assert.deepEqual(refusedPayload({ email: 'rules.email', phone: 'rules.phone' }), { fields: ['email', 'phone'], first: 'rules.email' });
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, 'rules.required']));
    assert.equal(refusedPayload(many).fields.length, 20);
    assert.equal(refusedPayload({ rows: ['rules.min', 'rules.max'] }).first, 'rules.min');
    assert.equal(refusedPayload({ bag: { amount: 'rules.money' } }).first, 'rules.money');
    assert.deepEqual(refusedPayload(null), { fields: [] });
});

test('press, dialog and error payloads are short', () => {
    assert.deepEqual(pressPayload({ label: '  Tallenna\n  muutokset ', tag: 'BUTTON', role: null, href: '' }), { label: 'Tallenna muutokset', tag: 'button', role: '', href: '' });
    assert.equal(pressPayload({ label: 'x'.repeat(500), tag: 'A', href: '/a' }).label.length, 80);
    assert.deepEqual(dialogPayload(1, ' Merkitse  maksetuksi '), { open: true, title: 'Merkitse maksetuksi' });
    assert.equal(errorPayload(new TypeError(`x is undefined ${'y'.repeat(500)}`)).message.length, 300);
    assert.equal(errorPayload(new TypeError('x')).name, 'TypeError');
    assert.deepEqual(errorPayload(undefined), { name: 'Error', message: '' });
    assert.deepEqual(errorPayload('a plain rejection'), { name: 'Error', message: 'a plain rejection' });
    assert.deepEqual(errorPayload({ status: 500 }), { name: 'Error', message: '' });
    assert.equal(words(null), '');
});

/* ── Chunks and answers ────────────────────────────────────────────────── */

test('events go as one JSON array while small; a big batch is halved until each part fits, in order', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ type: 3, timestamp: i, data: { pad: 'x'.repeat(100) } }));
    assert.deepEqual(packEvents(events), [JSON.stringify(events)]);
    assert.ok(MAX_CHUNK_CHARS >= 1_000_000 && MAX_CHUNK_CHARS < 16 * 1024 * 1024, "inside the contract's 16 MiB unpacked");

    const parts = packEvents(events, 400);
    assert.ok(parts.length > 1);
    parts.forEach((json) => assert.ok(json.length <= 400 || JSON.parse(json).length === 1));
    assert.deepEqual(parts.flatMap((json) => JSON.parse(json)), events);

    const lone = [{ type: 2, data: { pad: 'x'.repeat(1000) } }];
    assert.deepEqual(packEvents(lone, 100), [JSON.stringify(lone)], 'one event too big still goes alone');
    assert.deepEqual(packEvents([]), []);
    assert.deepEqual(packEvents(undefined), []);
});

test('a chunk the service finds too big is split in two; one event cannot be split', () => {
    const json = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]);
    assert.deepEqual(splitJson(json), ['[{"a":1},{"a":2}]', '[{"a":3}]']);
    assert.equal(splitJson('[{"a":1}]'), null);
    assert.equal(splitJson('nope'), null);
    assert.equal(splitJson('{"a":1}'), null);
});

test("every row of the contract's answer table", () => {
    assert.equal(answerFor(204), 'stored', 'stored, or stored before');
    assert.equal(answerFor(200), 'stored');
    assert.equal(answerFor(401), 'refresh', 'ask the host for a fresh token, send again');
    assert.equal(answerFor(403), 'stop', 'not this origin, key or yes');
    assert.equal(answerFor(402), 'stop', "the project's subscription has ended: nothing more from this page");
    assert.equal(answerFor(403, 'before-consent'), 'drop', 'a chunk from before the yes: only that chunk goes');
    assert.equal(answerFor(403, 'mask-required'), 'stop');
    assert.equal(answerFor(404), 'rotate', "the id is another subject's");
    assert.equal(answerFor(409), 'rotate', "the recording is another account's");
    assert.equal(answerFor(413), 'split');
    assert.equal(answerFor(422), 'drop', 'not a gzip of events, or a leak');
    assert.equal(answerFor(429), 'retry');
    assert.equal(answerFor(500), 'retry');
    assert.equal(answerFor(503), 'retry');
    assert.equal(answerFor(0), 'retry', 'no answer (offline, or CORS refused)');
    assert.equal(answerFor(undefined), 'retry');
    assert.equal(answerFor(400), 'drop', 'an answer the contract does not name: never storable');
    assert.equal(answerFor(419), 'drop', 'no session, no CSRF: not ours');
});

test('the chunk URL: /v1/parts/{id} with key, token, doc and seq in the query', () => {
    const url = chunkUrl({ url: 'https://sessions.example.com/', key, token }, { id: ID_A, doc: 2, seq: 17 });
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, `https://sessions.example.com/v1/parts/${ID_A}`);
    assert.deepEqual([...parsed.searchParams.keys()], ['key', 't', 'doc', 'seq']);
    assert.equal(parsed.searchParams.get('key'), key);
    assert.equal(parsed.searchParams.get('t'), token);
    assert.equal(parsed.searchParams.get('doc'), '2');
    assert.equal(parsed.searchParams.get('seq'), '17');
    assert.equal(new URL(chunkUrl({ url: 'http://localhost:8007/base', key }, { id: ID_A, doc: 1, seq: 0 })).pathname, `/base/v1/parts/${ID_A}`);
    assert.equal(new URL(chunkUrl({ url: 'http://localhost:8007', key }, { id: ID_A, doc: 1, seq: 0 })).searchParams.has('t'), false);
});

test('an upload is a CORS-simple POST: text/plain, no credentials, no other header', () => {
    const body = new Uint8Array([1, 2]);
    const init = uploadInit(body, true);
    assert.equal(init.method, 'POST');
    assert.equal(init.mode, 'cors');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.keepalive, true);
    assert.deepEqual(init.headers, { 'Content-Type': 'text/plain' });
    assert.equal(init.body, body);
    assert.equal(uploadInit(body).keepalive, false);
});

test('gzip gives the bytes the service gunzips back to the same JSON array', async () => {
    const json = JSON.stringify([{ type: 4, data: { href: 'http://localhost:8001/', width: 1440, height: 900 }, timestamp: 1 }, { type: 5, data: { tag: 'env', payload: { lang: 'fi', path: '/ä' } }, timestamp: 2 }]);
    const body = await gzip(json);
    assert.ok(body instanceof Uint8Array);
    assert.equal(body[0], 0x1f);
    assert.equal(body[1], 0x8b);
    assert.equal(gunzipSync(body).toString('utf8'), json);
    const repetitive = JSON.stringify(Array.from({ length: 2000 }, () => ({ class: 'flex items-center gap-2 rounded-lg px-3 py-2' })));
    assert.ok((await gzip(repetitive)).byteLength < repetitive.length / 10, 'utility classes compress well');
});
