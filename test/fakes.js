// Stand-ins for the browser the recorder runs in: a window with sessionStorage and listeners fired by hand, rrweb's
// record() emitting what the test asks, and a fetch that answers from a list. No DOM: the recorder only needs this.
import { gunzipSync } from 'node:zlib';
import { clientTokenFixture } from './fixtures.js';

/** A sessionStorage stand-in. */
export function memoryStore(initial = {}) {
    const items = new Map(Object.entries(initial));
    return {
        getItem: (k) => (items.has(k) ? items.get(k) : null),
        setItem: (k, v) => { items.set(k, String(v)); },
        removeItem: (k) => { items.delete(k); },
        items,
    };
}

/** A storage the browser refuses (a private window, blocked site data): every call throws. */
export const refusing = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); },
};

/** A client token signed by nobody (the browser never verifies), valid now, its yes a minute old. */
export function tokenFor(more = {}) {
    const { claims } = clientTokenFixture();
    const now = Math.floor(Date.now() / 1000);
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ typ: 'JWT', alg: 'HS256' })}.${part({ ...claims, iat: now, exp: now + 1800, consent_at: Date.now() - 60_000, ...more })}.signature`;
}

/** Lets the recorder's promises (gzip, fetch, getToken) run to their end; a big gzip runs on zlib's thread pool. */
export async function settle() {
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

/** A window good enough for the recorder. `runTimers()` runs what is due soon (the start, a tail); `tick()` the 5 s beat. */
export function fakeWindow({ store = memoryStore(), path = '/properties/77', search = '?q=Virtanen' } = {}) {
    const listeners = new Map();
    const docListeners = new Map();
    const add = (map) => (type, fn) => {
        if (!map.has(type)) map.set(type, []);
        map.get(type).push(fn);
    };
    let timers = [];
    const win = {
        document: {
            documentElement: { getAttribute: (name) => ({ lang: 'fi', 'data-theme': 'dark' })[name] ?? null, className: 'translated-ltr' },
            visibilityState: 'visible',
            addEventListener: add(docListeners),
            querySelectorAll: () => [],
            createElement: () => ({
                matches: (selector) => {
                    if (selector.includes('((')) throw new SyntaxError(`'${selector}' is not a valid selector`);
                    return false;
                },
            }),
        },
        location: { pathname: path, search, href: `https://app.example.com${path}${search}` },
        innerWidth: 1440,
        innerHeight: 900,
        devicePixelRatio: 2,
        sessionStorage: store,
        addEventListener: add(listeners),
        setTimeout: (fn, ms = 0) => {
            timers.push({ fn, ms });
            return timers.length;
        },
        clearTimeout: () => {},
        setInterval: (fn) => {
            win.tick = fn;
            return 1;
        },
        tick: () => {},
        fire: (type, event = {}) => (listeners.get(type) ?? []).forEach((fn) => fn(event)),
        fireDoc: (type, event = {}) => (docListeners.get(type) ?? []).forEach((fn) => fn(event)),
        runTimers: () => {
            const due = timers.filter((t) => t.ms < 10_000);
            timers = timers.filter((t) => t.ms >= 10_000);
            due.forEach((t) => t.fn());
        },
    };

    return win;
}

/** One element as the click listener sees it. */
export function element(tag, text, { label = null, privateAncestor = false, href = null } = {}) {
    const el = {
        nodeType: 1,
        tagName: tag,
        innerText: text,
        textContent: text,
        getAttribute: (name) => (name === 'aria-label' ? label : name === 'href' ? href : null),
        querySelector: () => null,
        closest: (selector) => (selector.includes('data-mybeast-private') ? (privateAncestor ? {} : null) : el),
    };
    return el;
}

/** An rrweb full snapshot: a button the dictionary knows and a private card with a person in it. */
function snapshot() {
    return {
        type: 0,
        id: 1,
        childNodes: [{
            type: 2, tagName: 'html', id: 2, attributes: { lang: 'fi' },
            childNodes: [{
                type: 2, tagName: 'body', id: 3, attributes: {},
                childNodes: [
                    { type: 2, tagName: 'button', id: 4, attributes: { title: 'Liisa Virtanen' }, childNodes: [{ type: 3, id: 5, textContent: 'Save' }] },
                    { type: 2, tagName: 'div', id: 6, attributes: { 'data-mybeast-private': '' }, childNodes: [{ type: 3, id: 7, textContent: 'Liisa Virtanen' }] },
                    { type: 2, tagName: 'a', id: 8, attributes: { href: '/tenants/01a17862-0000-7000-8000-000000000001?q=Liisa' }, childNodes: [{ type: 3, id: 9, textContent: 'Cancel' }] },
                ],
            }],
        }],
    };
}

/** rrweb's record(): a Meta and a FullSnapshot at start, custom events while it runs. */
export function fakeRrweb({ fails = false } = {}) {
    let emit = null;
    const runs = [];
    const record = (options) => {
        runs.push(options);
        if (fails) throw new Error('rrweb cannot run here');
        emit = options.emit;
        emit({ type: 4, data: { href: 'https://app.example.com/properties/77?q=Virtanen', width: 1440, height: 900 }, timestamp: Date.now() });
        emit({ type: 2, data: { node: snapshot(), initialOffset: { left: 0, top: 0 } }, timestamp: Date.now() });
        return () => {
            emit = null;
        };
    };
    record.addCustomEvent = (tag, payload) => {
        if (!emit) throw new Error('please add custom event after start recording');
        emit({ type: 5, data: { tag, payload }, timestamp: Date.now() });
    };
    record.takeFullSnapshot = () => emit?.({ type: 2, data: { node: snapshot(), initialOffset: { left: 0, top: 0 } }, timestamp: Date.now() });

    return {
        record,
        runs,
        emit: (event) => emit?.(event),
        get running() {
            return emit !== null;
        },
    };
}

/** fetch(): answers from the list (204 once it is empty) - a status, or {status, body}; an Error in the list is thrown (no answer). */
export function fakeFetch(answers = []) {
    const calls = [];
    const fetch = async (url, init) => {
        const parsed = new URL(url);
        calls.push({
            url,
            init,
            id: parsed.pathname.split('/').pop(),
            token: parsed.searchParams.get('t'),
            doc: Number(parsed.searchParams.get('doc')),
            seq: Number(parsed.searchParams.get('seq')),
            events: JSON.parse(gunzipSync(init.body).toString('utf8')),
        });
        const next = answers.length ? answers.shift() : 204;
        if (next instanceof Error) throw next;
        if (typeof next === 'object') return { status: next.status, json: async () => next.body };
        return { status: next };
    };

    return { fetch, calls };
}
