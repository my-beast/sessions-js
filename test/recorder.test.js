// The recorder (src/recorder.js) end to end, without a browser: a fake window, rrweb's record() emitting a small page,
// and a fetch answering from a list. What leaves must fit the contract (schemas/README.md, "Uploading a chunk") and
// never carry the made-up person on the page; nothing the recorder meets may throw into the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Ajv from 'ajv';
import { init } from '../src/client.js';
import { createRecorder } from '../src/recorder.js';
import { KEYS, isUuid } from '../src/rules.js';
import { element, fakeFetch, fakeRrweb, fakeWindow, memoryStore, settle, tokenFor } from './fakes.js';
import { clientTokenFixture, readJson, schemaDir } from './fixtures.js';

const { public_key: key } = clientTokenFixture();
const chunkSchema = new Ajv({ allErrors: true, strict: false }).compile(readJson(join(schemaDir, 'recording-chunk.schema.json')));
const PERSON = ['Liisa', 'Virtanen', '01a17862-0000-7000-8000-000000000001'];
const leaks = (value) => PERSON.filter((s) => JSON.stringify(value).includes(s));

function setup({ token = tokenFor(), answers = [], store = memoryStore(), rrweb = {}, ...options } = {}) {
    const win = fakeWindow({ store });
    const rr = fakeRrweb(rrweb);
    const net = fakeFetch(answers);
    const client = init({ url: 'https://sessions.example.com', key, env: 'production', token });
    const changes = [];
    const recorder = createRecorder(client, {
        window: win,
        fetch: net.fetch,
        record: rr.record,
        onChange: (state) => changes.push(state),
        dictionary: ['Save', 'Cancel'],
        ...options,
    });

    return { win, rr, net, client, recorder, changes, store };
}

/** start() and let the idle-time start run. */
function started(context) {
    context.recorder.start();
    context.win.runTimers();
    return context;
}

const marks = (events, tag) => events.filter((e) => e.type === 5 && e.data.tag === tag).map((e) => e.data.payload);

test('records while the token allows it, and uploads a CORS-simple gzip chunk that fits the contract', async () => {
    const { rr, net, recorder, changes, client } = started(setup());

    assert.equal(rr.runs.length, 1);
    assert.equal(rr.runs[0].maskAllInputs, true, 'masked: every input');
    assert.match(rr.runs[0].blockSelector, /\bimg\b/);
    const recording = recorder.currentRecording();
    assert.ok(isUuid(recording.id));
    assert.ok(Math.abs(recording.startedAt - Date.now()) < 5000);

    recorder.pageChanged('Property/Show', '/properties/77?tab=money');
    await settle();

    assert.equal(net.calls.length, 1);
    const { url, init: request, events, id, doc, seq, token } = net.calls[0];
    assert.equal(new URL(url).origin + new URL(url).pathname, `https://sessions.example.com/v1/parts/${recording.id}`);
    assert.equal(new URL(url).searchParams.get('key'), key);
    assert.deepEqual([id, doc, seq, token], [recording.id, 1, 0, client.token]);
    assert.equal(request.method, 'POST');
    assert.equal(request.mode, 'cors');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.keepalive, false);
    assert.deepEqual(request.headers, { 'Content-Type': 'text/plain' }, 'no XSRF, no X-Requested-With: no preflight');
    assert.ok(chunkSchema(events), JSON.stringify(chunkSchema.errors));
    assert.deepEqual(leaks(events), []);
    assert.equal(events[0].data.href, 'https://app.example.com/properties/:id');
    assert.deepEqual(marks(events, 'env')[0], { path: '/properties/:id', w: 1440, h: 900, dpr: 2, lang: 'fi', theme: 'dark', translated: true, doc: 1, masked: true });
    assert.deepEqual(marks(events, 'page'), [{ name: 'Property/Show', url: '/properties/:id' }]);
    assert.deepEqual(recorder.state().upload, { status: 204, answer: 'stored', doc: 1, seq: 0, bytes: request.body.byteLength });
    assert.ok(changes.some((state) => state.status === 'recording' && state.recording?.id === recording.id));
});

test('nothing is recorded without the yes; a recorder without a client does nothing and breaks nothing', async () => {
    const { rr, net, recorder } = started(setup({ token: tokenFor({ rec: false }) }));
    assert.equal(rr.runs.length, 0);
    assert.equal(recorder.state().status, 'off');
    assert.equal(recorder.currentRecording(), null);

    const none = createRecorder(null);
    for (const call of ['start', 'stop', 'flush', 'setToken', 'mark', 'pageChanged']) assert.doesNotThrow(() => none[call]('x', {}));
    assert.equal(none.currentRecording(), null);
    assert.deepEqual(none.state(), { status: 'off', recording: null, upload: null });
    assert.equal(createRecorder({ url: 'https://x', key }, { fetch: async () => ({ status: 204 }) }).currentRecording(), null, 'no window (Node)');

    recorder.mark('x', {});
    await settle();
    assert.equal(net.calls.length, 0);
});

test('unmasked only when the token says mask: false - then only passwords are hidden', async () => {
    const { rr, net, recorder } = started(setup({ token: tokenFor({ mask: false }) }));
    assert.equal(rr.runs[0].maskAllInputs, false);
    assert.deepEqual(rr.runs[0].maskInputOptions, { password: true });
    recorder.flush();
    await settle();
    assert.equal(marks(net.calls[0].events, 'env')[0].masked, false);
    assert.ok(JSON.stringify(net.calls[0].events).includes('Virtanen'), 'not masked: the replay shows it as it was');
});

test('401: the host gives a fresh token, the chunk goes again with it', async () => {
    const fresh = tokenFor({ env: 'staging' });
    let asked = 0;
    const { net, recorder } = started(setup({ answers: [401, 204], getToken: async () => { asked += 1; return fresh; } }));
    recorder.flush();
    await settle();

    assert.equal(asked, 1);
    assert.equal(net.calls.length, 2);
    assert.equal(net.calls[1].token, fresh);
    assert.deepEqual([net.calls[1].id, net.calls[1].doc, net.calls[1].seq], [net.calls[0].id, 1, 0], 'the same chunk: a retry is always safe');
    assert.equal(recorder.state().status, 'recording');
});

test('401 after the host gave a fresher token meanwhile: sent again with that one, getToken not asked', async () => {
    let asked = 0;
    const { net, recorder } = started(setup({ answers: [401, 204], getToken: async () => { asked += 1; return null; } }));
    recorder.flush(); // on its way with the first token...
    const fresh = tokenFor({ env: 'staging' });
    recorder.setToken(fresh); // ...when the next response brings a new one
    await settle();
    assert.equal(asked, 0);
    assert.equal(net.calls.length, 2);
    assert.equal(net.calls[1].token, fresh);
    assert.equal(recorder.state().status, 'recording');
});

test('401 and no fresh token: recording stops until the host sets one', async () => {
    const { net, recorder, win } = started(setup({ answers: [401], getToken: async () => null }));
    recorder.flush();
    await settle();
    assert.equal(recorder.state().status, 'refused');
    recorder.pageChanged('Next', '/next');
    win.tick();
    await settle();
    assert.equal(net.calls.length, 1);

    const fresh = tokenFor({ env: 'staging' });
    recorder.setToken(fresh);
    win.runTimers();
    assert.equal(recorder.state().status, 'recording');
    recorder.flush();
    await settle();
    assert.equal(net.calls.at(-1).token, fresh);
});

test('401 without getToken, or a second 401 after a fresh token, stops too', async () => {
    const alone = started(setup({ answers: [401] }));
    alone.recorder.flush();
    await settle();
    assert.equal(alone.recorder.state().status, 'refused');

    const twice = started(setup({ answers: [401, 401], getToken: () => tokenFor({ env: 'staging' }) }));
    twice.recorder.flush();
    await settle();
    assert.equal(twice.net.calls.length, 2);
    assert.equal(twice.recorder.state().status, 'refused');
});

test('403: nothing more from this page load, a new token or not', async () => {
    const { net, recorder, win, rr } = started(setup({ answers: [403] }));
    recorder.flush();
    await settle();
    assert.equal(recorder.state().status, 'refused');
    assert.equal(rr.running, false);
    recorder.setToken(tokenFor({ env: 'staging' }));
    win.runTimers();
    win.tick();
    await settle();
    assert.equal(net.calls.length, 1);
    assert.equal(rr.runs.length, 1);
});

test('403 before-consent: that chunk is dropped and recording goes on', async () => {
    const { net, recorder } = started(setup({ answers: [{ status: 403, body: { refused: 'before-consent' } }] }));
    recorder.flush();
    await settle();
    assert.equal(recorder.state().status, 'recording');
    recorder.mark('custom', { n: 1 });
    recorder.flush();
    await settle();
    assert.equal(net.calls.length, 2);
    assert.equal(recorder.state().upload.status, 204);
});

test('404 / 409: a new recording, with a fresh snapshot; a second refusal in a row stops', async () => {
    const { net, recorder } = started(setup({ answers: [404, 204, 409, 409] }));
    const first = recorder.currentRecording().id;
    recorder.flush();
    await settle();
    const second = recorder.currentRecording().id;
    assert.notEqual(second, first);
    recorder.flush();
    await settle();
    assert.equal(net.calls[1].id, second);
    assert.deepEqual([net.calls[1].doc, net.calls[1].seq], [1, 0]);
    assert.ok(net.calls[1].events.some((e) => e.type === 2), 'the new recording starts with a full snapshot');
    assert.equal(marks(net.calls[1].events, 'env')[0].rotated, true);

    recorder.mark('step', { n: 1 });
    recorder.flush(); // 409: a third id
    await settle();
    const third = recorder.currentRecording().id;
    assert.notEqual(third, second);
    recorder.mark('step', { n: 2 });
    recorder.flush(); // 409 again: refused
    await settle();
    assert.equal(recorder.state().status, 'refused');
});

test('413: the chunk goes again in two halves; 422: it is dropped', async () => {
    const { net, recorder, win } = started(setup({ answers: [413, 204, 204, 422] }));
    recorder.flush();
    await settle();
    assert.equal(net.calls.length, 3);
    assert.deepEqual(net.calls.slice(1).map((c) => c.seq), [1, 2]);
    assert.deepEqual([...net.calls[1].events, ...net.calls[2].events], net.calls[0].events);

    recorder.mark('step', { n: 1 });
    recorder.flush();
    await settle();
    win.tick();
    await settle();
    assert.equal(net.calls.length, 4, 'a 422 is not sent again');
    assert.equal(recorder.state().status, 'recording');
});

test('429, 5xx and no answer: three tries, then the chunk is let go', async () => {
    const { net, recorder, win } = started(setup({ answers: [503, new TypeError('Failed to fetch'), 429] }));
    recorder.flush();
    await settle();
    win.tick();
    await settle();
    win.tick();
    await settle();
    win.tick();
    await settle();
    assert.equal(net.calls.length, 3);
    assert.deepEqual(net.calls.map((c) => c.seq), [0, 0, 0]);
    assert.equal(recorder.state().upload.answer, 'retry');
    assert.equal(recorder.state().status, 'recording');
});

test('another person or account in a new token: a new recording; what came before goes under the old token', async () => {
    const { net, recorder, client } = started(setup());
    const first = recorder.currentRecording().id;
    const other = tokenFor({ sub: 'user-other', acct: 'acct-other' });
    recorder.setToken(other);
    await settle();
    const second = recorder.currentRecording().id;
    assert.notEqual(second, first);
    recorder.flush();
    await settle();
    assert.deepEqual([net.calls[0].id, net.calls[0].token], [first, client.token]);
    assert.deepEqual([net.calls[1].id, net.calls[1].token, net.calls[1].doc, net.calls[1].seq], [second, other, 1, 0]);
});

test('a token that does not allow recording stops it; one that does goes on with the same recording', async () => {
    const { net, recorder, rr, win, client } = started(setup());
    const id = recorder.currentRecording().id;
    recorder.setToken(tokenFor({ rec: false }));
    assert.equal(rr.running, false);
    assert.equal(recorder.state().status, 'off');
    await settle();
    assert.equal(net.calls[0].token, client.token, 'what was recorded goes with the token it was recorded under');

    recorder.setToken(tokenFor({ env: 'staging' }));
    win.runTimers();
    assert.equal(rr.runs.length, 2);
    assert.equal(recorder.currentRecording().id, id);
});

test('masking switched in a new token is a recording of its own, never a mix', async () => {
    const { recorder, rr, win, net } = started(setup());
    const id = recorder.currentRecording().id;
    recorder.setToken(tokenFor({ mask: false }));
    win.runTimers();
    assert.equal(rr.runs.length, 2);
    assert.equal(rr.runs[1].maskAllInputs, false);
    assert.notEqual(recorder.currentRecording().id, id);
    await settle();
    assert.equal(net.calls[0].id, id, 'the masked part went under the masked token');
});

test("the host's marks: payload masked like text, the host's object left as it was", async () => {
    const { net, recorder } = started(setup());
    const payload = { who: 'Liisa Virtanen', step: 2, label: 'Save' };
    recorder.mark('checkout', payload);
    recorder.mark('x'.repeat(40), { n: 1 });
    recorder.mark('refused', { fields: ['email'], first: 'rules.email' });
    recorder.mark('', { n: 1 });
    recorder.mark('big', { pad: 'x'.repeat(5000) });
    recorder.flush();
    await settle();
    const { events } = net.calls[0];
    assert.deepEqual(payload, { who: 'Liisa Virtanen', step: 2, label: 'Save' });
    assert.deepEqual(marks(events, 'checkout'), [{ who: '***** ********', step: 2, label: 'Save' }]);
    assert.equal(marks(events, 'x'.repeat(32)).length, 1, 'a tag is 32 characters at most');
    assert.deepEqual(marks(events, 'refused'), [{ fields: ['email'], first: 'rules.email' }]);
    assert.deepEqual(marks(events, 'big'), [{}], 'too big: the mark keeps its name only');
    assert.ok(chunkSchema(events), JSON.stringify(chunkSchema.errors));
});

test('built-in marks: press, error, hidden / visible, and the page name from currentPage()', async () => {
    const { net, recorder, win } = started(setup({ currentPage: () => 'Tenant/Show' }));
    win.fireDoc('click', { target: element('BUTTON', 'Save') });
    win.fireDoc('click', { target: element('BUTTON', 'Liisa Virtanen', { privateAncestor: true }) });
    win.fireDoc('click', { target: element('A', 'Cancel', { href: '/tenants/01a17862-0000-7000-8000-000000000001?q=Liisa' }) });
    win.fireDoc('click', { target: { closest: () => null } });
    win.fire('error', { error: new TypeError('Cannot read liisa.virtanen@example.fi'), message: 'x' });
    win.fire('unhandledrejection', { reason: 'Liisa Virtanen' });
    win.document.visibilityState = 'hidden';
    win.fireDoc('visibilitychange');
    win.document.visibilityState = 'visible';
    win.fireDoc('visibilitychange');
    win.runTimers();
    recorder.flush();
    await settle();
    const events = net.calls.flatMap((c) => c.events);
    assert.deepEqual(leaks(events), []);
    assert.deepEqual(marks(events, 'page')[0], { name: 'Tenant/Show', url: '/properties/:id' });
    assert.deepEqual(marks(events, 'press'), [
        { label: 'Save', tag: 'button', role: '', href: '' },
        { label: '***** ********', tag: 'button', role: '', href: '' },
        { label: 'Cancel', tag: 'a', role: '', href: '/tenants/:id' },
    ]);
    const errors = marks(events, 'error');
    assert.equal(errors[0].name, 'TypeError');
    assert.ok(!errors[0].message.includes('liisa'));
    assert.equal(errors[1].name, 'Error');
    assert.equal(marks(events, 'hidden').length, 1);
    assert.equal(marks(events, 'visible').length, 1);
});

test('one recording per tab across page loads: the next document, or a new one for someone else', () => {
    const store = memoryStore();
    const first = started(setup({ store }));
    const id = first.recorder.currentRecording().id;
    assert.equal(store.items.get(KEYS.doc), '1');

    const reload = started(setup({ store }));
    assert.equal(reload.recorder.currentRecording().id, id);
    assert.equal(store.items.get(KEYS.doc), '2');

    const otherAccount = started(setup({ store, token: tokenFor({ acct: 'acct-other' }) }));
    assert.notEqual(otherAccount.recorder.currentRecording().id, id);
    assert.equal(store.items.get(KEYS.doc), '1');
    assert.equal(store.items.get(KEYS.account), 'acct-other');
});

test('a duplicated tab (it copied sessionStorage) takes a recording of its own', () => {
    const channels = [];
    const context = setup();
    context.win.BroadcastChannel = class {
        constructor(name) {
            this.name = name;
            this.sent = [];
            channels.push(this);
        }
        postMessage(message) {
            this.sent.push(message);
        }
    };
    started(context);
    const id = context.recorder.currentRecording().id;
    assert.equal(channels[0].name, 'mybeast-rec');
    assert.deepEqual(channels[0].sent[0], { kind: 'ping', id });
    channels[0].onmessage({ data: { kind: 'same', id } });
    assert.notEqual(context.recorder.currentRecording().id, id);
    channels[0].onmessage({ data: { kind: 'ping', id: context.recorder.currentRecording().id } });
    assert.deepEqual(channels[0].sent.at(-1), { kind: 'same', id: context.recorder.currentRecording().id }, 'and answers the next tab');
});

test('a hidden page whose keepalive got no answer sends that chunk again the normal way', async () => {
    const { net, win } = started(setup({ answers: [new Error('offline')] }));
    win.document.visibilityState = 'hidden';
    win.fireDoc('visibilitychange');
    await settle();
    assert.equal(net.calls.length, 2);
    assert.equal(net.calls[0].init.keepalive, true);
    assert.equal(net.calls[1].init.keepalive, false, 'the page is still here: sent again');
    assert.deepEqual([net.calls[1].doc, net.calls[1].seq], [net.calls[0].doc, net.calls[0].seq], 'the same chunk');
});

test('a page going away sends its last chunk as keepalive; a big one waits in the tab for the next page', async () => {
    const store = memoryStore();
    const small = started(setup({ store }));
    small.win.fire('pagehide');
    await settle();
    assert.equal(small.net.calls.length, 1);
    assert.equal(small.net.calls[0].init.keepalive, true);
    assert.equal(marks(small.net.calls[0].events, 'pagehide').length, 1);
    assert.equal(store.items.has(KEYS.tail), false, 'taken back out of the tab: sent once');

    const big = started(setup({ store }));
    const bigId = big.recorder.currentRecording().id;
    big.rr.emit({ type: 3, timestamp: Date.now(), data: { source: 2, type: 2, id: 1, x: 1, y: 1, pad: randomBytes(90_000).toString('base64') } });
    big.win.fire('pagehide');
    await settle();
    assert.equal(big.net.calls.length, 0, 'over the keepalive budget');
    assert.ok(store.items.has(KEYS.tail));
    assert.ok(!store.items.get(KEYS.tail).includes(big.client.token), 'no token in the tab');

    const next = started(setup({ store }));
    await settle();
    assert.equal(next.net.calls.length, 1, "the next page sends the last one's tail");
    assert.equal(next.net.calls[0].token, next.client.token);
    assert.deepEqual([next.net.calls[0].id, next.net.calls[0].doc], [bigId, 2], 'filed under the page that recorded it');
    assert.equal(next.recorder.currentRecording().id, bigId, 'the same recording goes on as document 3');
    assert.equal(store.items.has(KEYS.tail), false);
});

test('idle minutes without input pause it; the next input starts a new recording', () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        const { recorder, win } = started(setup({ idleMinutes: 30 }));
        const id = recorder.currentRecording().id;
        now += 31 * 60_000;
        win.tick();
        assert.equal(recorder.state().status, 'paused');
        assert.equal(recorder.currentRecording(), null);
        win.fire('pointerdown');
        win.runTimers();
        assert.equal(recorder.state().status, 'recording');
        assert.notEqual(recorder.currentRecording().id, id);
    } finally {
        Date.now = realNow;
    }
});

test('a token about to run out is renewed before the service refuses it', async () => {
    const fresh = tokenFor({ env: 'staging' });
    let asked = 0;
    const now = Math.floor(Date.now() / 1000);
    const { net, recorder, win } = started(setup({ token: tokenFor({ iat: now - 1700, exp: now + 60 }), getToken: async () => { asked += 1; return fresh; } }));
    win.tick();
    await settle();
    win.tick();
    await settle();
    assert.equal(asked, 1);
    recorder.mark('step', {});
    recorder.flush();
    await settle();
    assert.equal(net.calls.at(-1).token, fresh);
});

test('a browser whose clock is behind the yes waits before recording', () => {
    const { rr, recorder } = started(setup({ token: tokenFor({ consent_at: Date.now() + 60_000 }) }));
    assert.equal(rr.runs.length, 0);
    assert.equal(recorder.state().status, 'waiting');
});

test('stop(): what was recorded still goes; nothing more until start()', async () => {
    const { net, recorder, rr, win } = started(setup());
    recorder.stop();
    assert.equal(rr.running, false);
    assert.equal(recorder.currentRecording(), null);
    await settle();
    assert.equal(net.calls.length, 1);
    win.tick();
    await settle();
    assert.equal(net.calls.length, 1);
    recorder.start();
    win.runTimers();
    assert.equal(rr.runs.length, 2);
});

test('nothing breaks the host: a throwing fetch, rrweb, onChange or storage', async () => {
    const throwing = started(setup({
        fetch: () => { throw new Error('blocked by an extension'); },
        onChange: () => { throw new Error('host bug'); },
    }));
    assert.doesNotThrow(() => throwing.recorder.flush());
    await settle();

    const broken = setup({ rrweb: { fails: true } });
    assert.doesNotThrow(() => broken.recorder.start());
    for (let i = 0; i < 3; i++) {
        broken.win.runTimers();
        broken.win.tick();
    }
    broken.win.runTimers();
    assert.equal(broken.recorder.state().status, 'refused');
    assert.equal(broken.rr.runs.length, 3, 'three tries, then it leaves the page alone');

    const noStorage = setup();
    noStorage.win.sessionStorage = { getItem: () => { throw new Error('SecurityError'); } };
    const recorder = createRecorder(noStorage.client, { window: noStorage.win, fetch: noStorage.net.fetch, record: noStorage.rr.record });
    recorder.start();
    noStorage.win.runTimers();
    assert.ok(recorder.currentRecording(), 'records without carrying anything over');
});
