// The session recorder: rrweb in this tab while the host and the
// token allow it, uploaded in gzip chunks to Sessions (schemas/README.md, "Uploading a chunk"). Pure
// parts (ids, tail, payloads, answers): ./rules.js. Masking: ./mask.js. This is the only file that imports rrweb, so
// a host can load it lazily and keep rrweb out of its main bundle.
//
// Masked unless the token says mask: false in so many words (fail closed): only the host's own words stay readable,
// every value, name and id is hidden before an event leaves the page. Unmasked hides only passwords - for local
// debugging.
//
// - One recording per tab (sessionStorage), carried across full page loads as documents 1, 2, ...; a new one after
//   idleMinutes without input (recording pauses at that point, the next input starts the new one), after
//   maxMinutes, for another person or account (the token's sub and acct), and in a duplicated tab (BroadcastChannel).
// - Chunks go every 5 s and on every page change, one request at a time. A page that goes away leaves what it could
//   not send in the tab (`mybeast-rec-tail`) for the next page; only a chunk under 60 000 bytes rides a keepalive
//   request (the browser's 64 KiB keepalive budget is shared with the page's other beacons, @mybeast/errors' too).
// - Each chunk goes with the token it was recorded under, so a page that may not be recorded still sends what the
//   page before it recorded. A 401 asks the host for a fresh token (`getToken`); so does a token about to run out.
// - Nothing here may break the host page: every listener is wrapped, every promise caught, and rrweb's errorHandler
//   swallows rrweb's own errors.
//
// Uploads use fetch with keepalive, not a form or the host's HTTP client: this is fire-and-forget telemetry that must
// survive the page unloading, and `fetch(..., { keepalive })` is the only transport that does.

import { record as rrwebRecord } from '@rrweb/record';
import { createMask } from './mask.js';
import {
    CHANNEL,
    KEYS,
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
    limitsOf,
    mintIdentity,
    newId,
    packEvents,
    pagePayload,
    ping,
    pressPayload,
    pushTail,
    readIdentity,
    renewReason,
    replyTo,
    sameHolder,
    scrubEvent,
    splitJson,
    tailsOf,
    takeTails,
    uploadInit,
    whenIdle,
    writeIdentity,
} from './rules.js';
import { secondsLeft } from './token.js';

const FLUSH_MS = 5000;
const KEEPALIVE_MAX_BYTES = 60_000;
const MAX_TRIES = 3;

/**
 * Chunks of this recording lost in a row with no answer at all (each after its tries): the service cannot be reached
 * from this page - an origin it does not list (its refusal carries no CORS header, so the page sees no status), a
 * blocker, a dead network. Recording stops here rather than sending every few seconds for nothing.
 */
const MAX_UNANSWERED = 3;

/** The headers the page's own requests carry while it records: the host's server ties its journey step (and errors) to the moment. */
const RECORDING_HEADERS = Object.freeze({ id: 'X-Recording-Id', at: 'X-Recording-At' });

/** Where the page's fetch and XMLHttpRequest look for the headers to add (installed once per window). */
const TAGGER = Symbol.for('@mybeast/sessions.requestHeaders');
const REFRESH_BEFORE_S = 120; // a token this close to running out is renewed before the service refuses it
const REFRESH_EVERY_MS = 60_000; // at most one early renewal a minute (a browser clock far ahead would ask nonstop)
const TOKEN_WAIT_MS = 15_000; // a getToken that never answers counts as none
const MAX_START_FAILURES = 3;
const MAX_MARK_CHARS = 4000;

const CONTROL = [
    'button', 'a', 'summary', 'label', 'select', '[role="button"]', '[role="tab"]', '[role="menuitem"]',
    '[role="option"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]', 'input[type="checkbox"]',
    'input[type="radio"]', 'input[type="submit"]', 'input[type="button"]',
].join(', ');
const DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
const DIALOG_TITLE = 'h1, h2, h3, [data-dialog-title]';
// Unmasked, only the host's explicit "never record this" is blocked.
const EXPLICIT_BLOCK = '[data-mybeast-block], [data-insights-block]';

const guard = (fn) => (...args) => {
    try {
        return fn(...args);
    } catch {
        return undefined; // the recorder must never break the host page
    }
};

const OFF_STATE = Object.freeze({ status: 'off', recording: null, upload: null });

/** What createRecorder returns when it cannot record at all: every call does nothing. */
function inert() {
    return {
        start() {},
        stop() {},
        mark() {},
        setToken() {},
        pageChanged() {},
        flush() {},
        currentRecording: () => null,
        requestHeaders: () => ({}),
        state: () => ({ ...OFF_STATE }),
    };
}

/**
 * The page's own requests carry the recording's headers while it records - the host's server reads them:
 * sessions-laravel files the journey step under the recording, errors-laravel links an error to its moment. Only to
 * the page's own origin (a header to another would cost it a preflight) and never to Sessions itself. Installed once
 * per window, on fetch and XMLHttpRequest; a later recorder takes over the source. A header the page set itself is
 * left as it is, and any trouble sends the request as it was.
 *
 * @param {Window} win
 * @param {() => Record<string, string>} source the headers of the moment ({} when not recording)
 * @param {string} serviceUrl
 */
function tagRequests(win, source, serviceUrl) {
    let origin = null;
    let service = null;
    try {
        origin = win.location.origin;
        service = new URL(serviceUrl, win.location.href).href;
    } catch {
        return;
    }
    if (!origin || origin === 'null') return;

    const installed = win[TAGGER] !== undefined;
    win[TAGGER] = source;
    if (installed) return;

    const headersFor = (url) => {
        try {
            const target = new URL(String(url), win.location.href);
            if (target.origin !== origin || target.href.startsWith(service)) return null;
            const headers = win[TAGGER]?.();
            return headers && headers[RECORDING_HEADERS.id] ? headers : null;
        } catch {
            return null;
        }
    };

    if (typeof win.fetch === 'function') {
        const fetch = win.fetch;
        win.fetch = function (input, init) {
            try {
                const request = typeof win.Request === 'function' && input instanceof win.Request;
                const add = headersFor(request ? input.url : input);
                if (add) {
                    const headers = new win.Headers(init?.headers ?? (request ? input.headers : undefined));
                    for (const [name, value] of Object.entries(add)) {
                        if (!headers.has(name)) headers.set(name, value);
                    }
                    init = { ...init, headers };
                }
            } catch {
                // sent as it was
            }
            return fetch.call(this, input, init);
        };
    }

    const proto = win.XMLHttpRequest?.prototype;
    if (proto && typeof proto.open === 'function' && typeof proto.send === 'function' && typeof proto.setRequestHeader === 'function') {
        const { open, send, setRequestHeader } = proto;
        const address = Symbol('address');
        const named = Symbol('named');
        proto.open = function (method, url, ...rest) {
            try {
                this[address] = url;
                this[named] = new Set();
            } catch {
                // sent as it was
            }
            return open.call(this, method, url, ...rest);
        };
        proto.setRequestHeader = function (name, value) {
            try {
                this[named]?.add(String(name).toLowerCase());
            } catch {
                // set as it was
            }
            return setRequestHeader.call(this, name, value);
        };
        proto.send = function (body) {
            try {
                const add = headersFor(this[address]);
                for (const [name, value] of Object.entries(add ?? {})) {
                    if (!this[named]?.has(name.toLowerCase())) setRequestHeader.call(this, name, value);
                }
            } catch {
                // sent as it was
            }
            return send.call(this, body);
        };
    }
}

function tabStore(win) {
    try {
        const store = win.sessionStorage;
        store.getItem(KEYS.id); // a refused storage throws here, not later

        return store;
    } catch {
        return null; // private window, blocked site data: this page records without carrying anything over
    }
}

/**
 * The recorder of one page load. `client` is what init() returned (null: a recorder that does nothing). Call once.
 *
 * @param {ReturnType<import('./client.js').init>} client
 * @param {{
 *   getToken?: () => Promise<string|null>|string|null, idleMinutes?: number, maxMinutes?: number,
 *   dictionary?: string[]|object|(() => string[]|object), readable?: (text: string) => boolean,
 *   privateSelectors?: string[]|string, blockSelectors?: string[]|string, keepAttributes?: string[],
 *   idPatterns?: RegExp[], routeWords?: string[]|((segment: string) => boolean),
 *   currentPage?: () => (string|null), onChange?: (state: object) => void, tagRequests?: boolean,
 *   window?: Window, fetch?: typeof fetch, record?: Function,
 * }} options `tagRequests: false` leaves the page's own requests without the recording's headers (requestHeaders()
 * gives them to add by hand). `window`, `fetch` and `record` (rrweb's) are for tests.
 */
export function createRecorder(client, options = {}) {
    try {
        return build(client, options ?? {});
    } catch {
        return inert();
    }
}

function build(client, options) {
    const win = options.window ?? globalThis.window;
    const doc = win?.document;
    const send = options.fetch ?? ((...args) => globalThis.fetch(...args));
    const record = options.record ?? rrwebRecord;
    if (!client || typeof client !== 'object' || typeof client.url !== 'string' || typeof client.key !== 'string') return inert();
    if (!doc || typeof globalThis.CompressionStream !== 'function' || (!options.fetch && typeof globalThis.fetch !== 'function')) return inert();

    const store = tabStore(win);
    const limits = limitsOf(options);
    let probe = null;
    try {
        probe = doc.createElement('div');
    } catch {
        probe = null;
    }
    const mask = createMask({
        ...options,
        validSelector: typeof probe?.matches === 'function'
            ? (selector) => {
                probe.matches(selector); // throws a SyntaxError for a selector the browser cannot read
                return true;
            }
            : undefined,
    });

    // The token as init() read it; init's own answer (recording, masked) has the last word on the first page.
    const first = authOf(client.key, client.token);
    const s = {
        auth: { ...first, recording: first.recording && client.recording === true, masked: first.masked || client.masked !== false },
        started: false, // the host called start() and not stop()
        masking: true, // how rrweb runs now
        id: null,
        doc: 0,
        seq: 0,
        start: 0,
        subject: '',
        account: '',
        lastInput: Date.now(),
        lastSaved: 0,
        stopRrweb: null, // rrweb's stop function while it runs
        paused: false, // stopped after idleMinutes without input; the next input starts a new recording
        renewNext: false, // the next start begins a new recording
        refused: '', // 'token': no token that holds (a later setToken lifts it); 'service' (or 'rrweb'): nothing more from this page load
        refusals: 0, // 404/409 answers in a row (a second one stops: something is wrong, not a stale id)
        unanswered: 0, // this recording's chunks lost in a row with no answer at all (MAX_UNANSWERED stops)
        bigDrops: 0, // events too big to store (the first asks for a new snapshot, the second stops)
        startFailures: 0,
        docStarted: false,
        startPending: false,
        buf: [],
        outbox: [],
        later: [], // chunks to try again on the next tick
        sending: null,
        keepaliveBytes: 0,
        channel: null,
        pingedAt: 0,
        dialogs: [],
        dialogTimer: null,
        observer: null,
        refreshing: null, // the getToken call in flight
        earlyRefreshAt: 0,
        pageName: null,
        upload: null, // the last answer: {status, answer, doc, seq, bytes}
    };

    const running = () => s.stopRrweb !== null;
    const wanted = () => s.started && s.auth.recording && !s.refused;
    const currentRecording = () => (running() && s.id ? { id: s.id, startedAt: s.start } : null);
    /** While recording, the headers that tie a request of this page to its moment; {} otherwise. */
    const requestHeaders = () => {
        const now = currentRecording();

        return now ? { [RECORDING_HEADERS.id]: now.id, [RECORDING_HEADERS.at]: String(Math.max(0, Date.now() - now.startedAt)) } : {};
    };
    if (options.tagRequests !== false) {
        try {
            tagRequests(win, requestHeaders, client.url);
        } catch {
            // the page's requests go as they were; the recording does not depend on it
        }
    }

    function status() {
        if (s.refused) return 'refused';
        if (running()) return 'recording';
        if (!wanted()) return 'off';
        return s.paused ? 'paused' : 'waiting';
    }

    const state = () => ({ status: status(), recording: currentRecording(), upload: s.upload ? { ...s.upload } : null });

    function announce() {
        try {
            options.onChange?.(state());
        } catch {
            // the host's own business
        }
    }

    const contextOf = () => ({ now: Date.now(), ...limits, subject: s.auth.subject, account: s.auth.account });
    const identityNow = () => ({ id: s.id, doc: s.doc, last: s.lastInput, start: s.start, subject: s.subject, account: s.account });

    function adopt(identity) {
        s.id = identity.id;
        s.doc = identity.doc;
        s.seq = 0;
        s.start = identity.start;
        s.subject = identity.subject;
        s.account = identity.account;
        if (identity.last > 0) s.lastInput = Math.max(s.lastInput, identity.last);
        writeIdentity(store, { ...identity, last: s.lastInput });
        s.lastSaved = s.lastInput;
    }

    function saveLastInput() {
        if (!store || !s.id || s.lastSaved === s.lastInput) return;
        try {
            store.setItem(KEYS.last, String(s.lastInput));
            s.lastSaved = s.lastInput;
        } catch {
            // full or refused: the next page may start a new recording a little early
        }
    }

    /** A chunk of what is buffered now: it goes with the token it was recorded under. */
    const chunkOf = (json) => ({
        id: s.id, doc: s.doc, seq: s.seq++, json, token: s.auth.token, subject: s.subject, account: s.account, masked: s.masking, tries: 0,
    });

    /* ── Marks ────────────────────────────────────────────────────────── */

    function emitMark(tag, payload) {
        if (!running()) return;
        try {
            record.addCustomEvent(tag, payload);
        } catch {
            // rrweb not recording after all
        }
    }

    /** The host's mark: a copy of its payload (the sanitizer cleans in place), plain JSON, at most 4000 characters. */
    function mark(tag, payload) {
        if (!running()) return;
        const name = typeof tag === 'string' ? tag.trim().slice(0, 32) : '';
        if (!name) return;
        let copy = {};
        try {
            const json = JSON.stringify(payload ?? {});
            copy = json && json.length <= MAX_MARK_CHARS ? JSON.parse(json) : {};
        } catch {
            copy = {}; // a cycle, a BigInt: the mark keeps its name only
        }
        emitMark(name, copy && typeof copy === 'object' && !Array.isArray(copy) ? copy : {});
    }

    const here = () => `${win.location?.pathname ?? ''}${win.location?.search ?? ''}`;

    function pageName() {
        try {
            const name = options.currentPage?.();
            if (typeof name === 'string' && name) return name;
        } catch {
            // the host's hook failed: what pageChanged() said last
        }

        return s.pageName;
    }

    function facts() {
        const root = doc.documentElement;

        return {
            path: here(),
            w: win.innerWidth,
            h: win.innerHeight,
            dpr: win.devicePixelRatio,
            lang: root?.getAttribute?.('lang') || '',
            theme: root?.getAttribute?.('data-theme') || '',
            className: root?.className ?? '',
        };
    }

    /** The marks that open a stretch of recording: where and how the screen is, and the page on it. */
    function opening(rotated) {
        emitMark('env', envPayload(facts(), s.doc, { rotated, masked: s.masking }));
        const name = pageName();
        if (name) emitMark('page', pagePayload(name, here()));
    }

    /* ── rrweb ────────────────────────────────────────────────────────── */

    function startRrweb() {
        try {
            const masked = s.auth.masked;
            // Masked: rrweb hides inputs and judges every text (rules 1-4) on the live page, then the sanitizer takes
            // attributes, URLs, ids and the marks (rules 5, 6) - an event it cannot read is dropped.
            const clean = masked ? mask.sanitizer() : scrubEvent;
            const masking = masked
                ? { maskAllInputs: true, maskTextSelector: '*', maskTextFn: mask.text, blockSelector: mask.blockSelector }
                : { maskAllInputs: false, maskInputOptions: { password: true }, blockSelector: EXPLICIT_BLOCK };
            const stop = record({
                emit(event) {
                    try {
                        const out = clean(event);
                        if (out) s.buf.push(out);
                    } catch {
                        // an event we cannot keep is lost, nothing more
                    }
                },
                ...masking,
                inlineStylesheet: true,
                inlineImages: false,
                recordCanvas: false,
                collectFonts: false,
                sampling: { mousemove: 50, scroll: 150, media: 800, input: 'all' },
                slimDOMOptions: 'all',
                errorHandler: () => true, // swallowed: a recorder error never reaches the host
            });
            if (typeof stop !== 'function') return false;
            s.stopRrweb = stop;
            s.masking = masked;
            watchDialogs(true);

            return true;
        } catch {
            return false;
        }
    }

    function stopRrweb() {
        const stop = s.stopRrweb;
        s.stopRrweb = null;
        watchDialogs(false);
        try {
            stop?.();
        } catch {
            // already gone
        }
    }

    /* ── Start, stop, pause, a new recording ──────────────────────────── */

    function startSoon() {
        if (s.startPending) return;
        s.startPending = true;
        whenIdle(guard(startNow), 1000, win);
    }

    function startNow() {
        s.startPending = false;
        if (!wanted() || s.paused || running()) return;
        if (!consentReached(s.auth, Date.now())) return; // this browser's clock is behind the yes: the next tick looks again
        const ctx = contextOf();
        let rotated = false;
        if (!s.docStarted) {
            // The first start of this page load: the tab's recording goes on as its next document, or a new one begins.
            adopt(identityForDocument(readIdentity(store), ctx).identity);
            s.docStarted = true;
            openChannel();
            sendTails();
        } else if (s.renewNext || renewReason(identityNow(), ctx)) {
            adopt(mintIdentity(ctx, newId));
            rotated = true;
        }
        s.renewNext = false;
        if (!startRrweb()) {
            s.startFailures += 1;
            if (s.startFailures >= MAX_START_FAILURES) refuse('rrweb'); // rrweb cannot run on this page
            return;
        }
        s.startFailures = 0;
        s.dialogs = [];
        opening(rotated);
        announce();
    }

    /** Make what runs match what is wanted: the host's start/stop, the token's yes, a refusal, a pause. */
    function sync() {
        if (wanted()) {
            if (!running() && !s.paused) startSoon();
        } else if (running()) {
            flush();
            stopRrweb();
        }
    }

    function start() {
        s.started = true;
        sync();
        announce();
    }

    /** The host: this page is not to be recorded (or the person signed out). What was recorded is still sent. */
    function stop() {
        s.started = false;
        s.paused = false;
        s.renewNext = false;
        if (running()) {
            flush();
            stopRrweb();
        }
        announce();
    }

    /** idleMinutes without input: stop here; the next input starts a new recording. */
    function pause() {
        flush();
        stopRrweb();
        s.paused = true;
        announce();
    }

    /**
     * 'service': the service will take nothing more from this page load. 'token': no token holds until setToken.
     * 'rrweb': rrweb would not start here.
     */
    function refuse(kind) {
        s.refused = kind;
        s.buf = [];
        s.outbox = [];
        s.later = [];
        if (kind === 'service') takeTails(store); // what this tab kept would be refused too
        stopRrweb();
        announce();
    }

    /**
     * A new recording from here on: after idle or maxMinutes (what came before is the old one's), for another person
     * or account, or when the old id is refused (404/409) or another tab writes to it - then what is buffered under
     * it is dropped, never sent.
     */
    function renew(reason) {
        const oldId = s.id;
        if (reason === 'refused' || reason === 'duplicate') {
            s.buf = [];
            s.outbox = s.outbox.filter((c) => c.id !== oldId);
            s.later = s.later.filter((c) => c.id !== oldId);
        } else {
            flush();
        }
        adopt(mintIdentity(contextOf(), newId));
        s.pingedAt = 0;
        if (running()) {
            try {
                record.takeFullSnapshot(true);
            } catch {
                // rrweb stopped meanwhile: the next start snapshots
            }
            s.dialogs = [];
            checkDialogsSoon(); // a dialog still open is told to the new recording too
            opening(true);
        }
        announce();
    }

    /* ── The token ────────────────────────────────────────────────────── */

    /** Chunks waiting for the same holder go with the fresher token (one that allows recording). */
    function retoken(auth) {
        for (const chunk of [...s.outbox, ...s.later]) if (sameHolder(chunk, auth)) chunk.token = auth.token;
    }

    /**
     * A new token from the host (a fresh one from each response, or getToken's). Another person or account is a new
     * recording; another masking is a recording of its own, never a mix of the two; a token that does not allow
     * recording stops it until one that does. An unreadable token, or one of another project, is no token.
     */
    function setToken(token) {
        const next = authOf(client.key, token);
        if (next.token === s.auth.token) return;
        flush(); // what was recorded so far leaves under the token it was recorded with
        s.auth = next;
        if (next.recording) {
            retoken(next);
            if (s.refused === 'token') s.refused = '';
        }
        if (running()) {
            if (!next.recording) {
                stopRrweb();
            } else if (next.masked !== s.masking) {
                stopRrweb();
                s.renewNext = true;
            } else if (next.subject !== s.subject || next.account !== s.account) {
                renew('holder');
            }
        }
        sync();
        announce();
    }

    /** The host's getToken, once at a time; null for none, a failure, or no answer within 15 s. */
    function askToken() {
        if (typeof options.getToken !== 'function') return Promise.resolve(null);
        s.refreshing ??= new Promise((resolve) => {
            let timer = null;
            try {
                timer = win.setTimeout(() => resolve(null), TOKEN_WAIT_MS);
            } catch {
                timer = null;
            }
            Promise.resolve()
                .then(() => options.getToken())
                .then((token) => resolve(typeof token === 'string' && token ? token : null), () => resolve(null))
                .finally(() => {
                    try {
                        if (timer !== null) win.clearTimeout(timer);
                    } catch {
                        // the timer answers null; resolve ignores a second answer
                    }
                });
        }).finally(() => {
            s.refreshing = null;
        });

        return s.refreshing;
    }

    /** A token about to run out is renewed before a chunk is refused for it (and before a keepalive goes out with it). */
    function refreshEarly() {
        const token = s.auth.token;
        if (!wanted() || !token || typeof options.getToken !== 'function' || s.refreshing) return;
        if (Date.now() - s.earlyRefreshAt < REFRESH_EVERY_MS) return;
        const left = secondsLeft(token);
        if (left === null || left > REFRESH_BEFORE_S) return;
        s.earlyRefreshAt = Date.now();
        askToken().then((fresh) => {
            if (fresh && s.auth.token === token) guard(setToken)(fresh);
        }).catch(() => {});
    }

    /* ── Chunks out ───────────────────────────────────────────────────── */

    function flush() {
        if (!s.buf.length) return;
        const events = s.buf;
        s.buf = [];
        if (!s.id) return;
        for (const json of packEvents(events)) s.outbox.push(chunkOf(json));
        pump();
    }

    /** One chunk at a time, in order; never rejects (a rejection would reach the host's error reporting as its own). */
    function pump() {
        sendNext().catch(() => {});
    }

    async function sendNext() {
        if (s.sending || s.refused) return;
        const chunk = s.outbox.shift();
        if (!chunk) return;
        s.sending = chunk;
        let status = 0;
        let refused = null;
        let bytes = 0;
        try {
            const body = await gzip(chunk.json);
            bytes = body.byteLength;
            const response = await send(chunkUrl({ url: client.url, key: client.key, token: chunk.token }, chunk), uploadInit(body, false));
            status = Number(response?.status) || 0;
            // A 403 says why in its body: only `before-consent` concerns this one chunk (rules.js answerFor).
            if (status === 403 && typeof response.json === 'function') refused = await response.json().then((body) => body?.refused ?? null, () => null);
        } catch {
            status = 0; // offline, the service down or not answering this origin: tried again later
        }
        if (s.sending !== chunk) return; // the page went away meanwhile and left it in the tail
        const answer = answerFor(status, refused);
        s.upload = { status, answer, doc: chunk.doc, seq: chunk.seq, bytes };
        if (answer === 'refresh') {
            await refreshFor(chunk);
            if (s.sending !== chunk) return;
        }
        s.sending = null;
        if (answer !== 'refresh') guard(settle)(chunk, answer);
        announce();
        if (s.outbox.length) pump();
    }

    /**
     * 401: the token does not hold. A fresher one the host already gave goes first; otherwise getToken is asked once
     * for this chunk. None (or the same one back, or a second 401 after a fresh one): nothing more until setToken.
     * A fresh token for someone else, or one that does not allow recording here, loses this chunk only.
     */
    async function refreshFor(chunk) {
        const resend = (asked) => {
            chunk.token = s.auth.token;
            chunk.refreshed = chunk.refreshed || asked;
            s.outbox.unshift(chunk);
        };
        if (s.auth.token && s.auth.token !== chunk.token && s.auth.recording && sameHolder(chunk, s.auth)) {
            resend(false); // a token the host gave since: tried first, getToken is still there if it does not hold
            return;
        }
        const fresh = chunk.refreshed ? null : await askToken();
        if (s.sending !== chunk) return;
        if (!fresh || fresh === chunk.token) {
            s.sending = null;
            refuse('token');
            return;
        }
        guard(setToken)(fresh);
        if (s.auth.token === fresh && s.auth.recording && sameHolder(chunk, s.auth)) resend(true);
    }

    function settle(chunk, answer) {
        switch (answer) {
            case 'stored':
                s.refusals = 0;
                s.unanswered = 0;
                return;
            case 'retry':
                chunk.tries += 1;
                if (chunk.tries < MAX_TRIES) s.later.push(chunk);
                else if (!s.upload?.status && chunk.id === s.id && ++s.unanswered >= MAX_UNANSWERED) refuse('unreachable');
                return;
            case 'stop':
                // A chunk of an earlier recording (a tail) can be refused for itself - from before the yes - and is
                // only dropped; a refusal of this recording's own chunk ends recording on this page.
                if (chunk.id === s.id) refuse('service');
                return;
            case 'rotate':
                if (chunk.id !== s.id) return; // an earlier recording's leftover: dropped
                s.refusals += 1;
                if (s.refusals >= 2) refuse('service');
                else renew('refused');
                return;
            case 'split': {
                const halves = chunk.id === s.id && chunk.doc === s.doc ? splitJson(chunk.json) : null;
                if (halves) {
                    for (const json of halves) s.outbox.push({ ...chunk, seq: s.seq++, json, tries: 0 });
                    return;
                }
                // One event too big to store (or an earlier page's chunk): it is lost. A lost snapshot leaves the
                // replay unable to draw what follows, so one new snapshot is taken; a second loss stops it here.
                if (chunk.id !== s.id || chunk.doc !== s.doc) return;
                s.bigDrops += 1;
                if (s.bigDrops >= 2) refuse('service');
                else if (running()) whenIdle(guard(() => running() && record.takeFullSnapshot(true)), 1000, win);
                return;
            }
            default:
                return; // 422 and the like: this chunk can never be stored
        }
    }

    /** Chunks an earlier page of this tab left behind (or this one, when it stayed after all), with this page's token. */
    function sendTails() {
        if (s.refused || !s.auth.recording || !s.auth.token) return; // they wait in the tab for a page that may send them
        for (const tail of tailsOf(takeTails(store), s.auth)) s.outbox.push({ ...tail, token: s.auth.token, tries: 0 });
        pump();
    }

    /**
     * The page is hidden or going away. The last seconds go in the tab first (sessionStorage is written at once); the
     * newest chunk is then taken back out and sent as a keepalive request if it is under 60 000 bytes gzipped and its
     * token still holds. Anything left is sent by the next page in this tab, or by this one if it is still here in
     * 1.5 s. `leaving`: also everything not yet stored (a request in flight is cut off with the page).
     */
    function final(leaving) {
        saveLastInput();
        const fresh = s.id && s.buf.length ? packEvents(s.buf).map(chunkOf) : [];
        s.buf = [];
        const waiting = leaving ? [...(s.sending ? [s.sending] : []), ...s.outbox, ...s.later] : [];
        if (leaving) {
            s.sending = null;
            s.outbox = [];
            s.later = [];
        }
        let kept = false;
        const newest = fresh.pop();
        for (const chunk of [...waiting, ...fresh]) {
            if (pushTail(store, chunk)) kept = true;
            else if (!leaving) s.outbox.push(chunk); // the tab keeps nothing: this page, still here, sends it
        }
        if (newest) {
            const inTail = pushTail(store, newest);
            kept = kept || inTail;
            const holds = (secondsLeft(newest.token) ?? 0) > 5; // a refused keepalive has no one left to send it again
            gzip(newest.json).then((body) => {
                const fits = holds && body.byteLength < KEEPALIVE_MAX_BYTES && s.keepaliveBytes + body.byteLength < KEEPALIVE_MAX_BYTES;
                if (!fits) {
                    if (!inTail && !leaving) {
                        s.outbox.push(newest);
                        pump();
                    }

                    return;
                }
                // Only while it still waits in the tab: whoever takes it out sends it, once.
                if (inTail && !dropTail(store, newest)) return;
                s.keepaliveBytes += body.byteLength;
                const done = (response) => {
                    s.keepaliveBytes = Math.max(0, s.keepaliveBytes - body.byteLength);
                    const status = Number(response?.status) || 0;
                    const answer = answerFor(status);
                    s.upload = { status, answer, doc: newest.doc, seq: newest.seq, bytes: body.byteLength };
                    // Only hidden, still here: a keepalive that got no answer (or a 401) goes back in the queue - the
                    // normal way sends it again and asks for a fresh token. A page that left has no one to do that.
                    if (!leaving && (answer === 'retry' || answer === 'refresh')) {
                        s.outbox.push({ ...newest, tries: 1 });
                        pump();
                    }
                    announce();
                };
                Promise.resolve()
                    .then(() => send(chunkUrl({ url: client.url, key: client.key, token: newest.token }, newest), uploadInit(body, true)))
                    .then(done, () => done(null));
            }).catch(() => {});
        }
        if (kept) {
            try {
                win.setTimeout(guard(sendTails), 1500);
            } catch {
                // the next page sends them
            }
        }
    }

    /* ── What the person does ─────────────────────────────────────────── */

    function activity() {
        const now = Date.now();
        const quiet = now - s.lastInput;
        s.lastInput = now;
        if (!wanted()) return;
        if (s.paused) {
            s.paused = false;
            s.renewNext = true;
            startSoon();
            announce();

            return;
        }
        if (!running()) return;
        if (quiet > limits.idleMs) whenIdle(guard(() => running() && renew('idle')), 500, win);
        else if (now - s.start > limits.maxMs) whenIdle(guard(() => running() && renew('max')), 500, win);
    }

    function tick() {
        if (running() && Date.now() - s.lastInput > limits.idleMs) pause();
        flush();
        saveLastInput();
        if (s.later.length) {
            s.outbox.push(...s.later);
            s.later = [];
        }
        pump();
        refreshEarly();
        if (wanted() && !s.paused && !running()) startSoon(); // e.g. waiting for this browser's clock to pass the yes
    }

    // What the control says to the person: its text without what is hidden from them - by CSS (a phone's short label
    // beside the desktop's long one) or aria-hidden (a bold copy that keeps a tab's width) - and with the break
    // between a card's title and its line kept, where textContent glues them together.
    function spoken(node) {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1 || node.getAttribute('aria-hidden') === 'true') return '';
        // `display: contents` draws no box of its own (checkVisibility says no): its children decide.
        const boxless = win.getComputedStyle?.(node)?.display === 'contents';
        if (!boxless && typeof node.checkVisibility === 'function' && !node.checkVisibility()) return '';
        if (!boxless && !node.querySelector('[aria-hidden="true"]')) return node.innerText ?? node.textContent ?? '';

        return Array.from(node.childNodes, spoken).join(' ');
    }

    function labelOf(el) {
        return el.getAttribute('aria-label') || spoken(el) || el.getAttribute('title') || el.value || '';
    }

    function titleOf(dialog) {
        const heading = dialog.querySelector(DIALOG_TITLE);
        const title = heading ? heading.textContent : dialog.getAttribute('aria-label');

        return s.masking ? mask.text(title, heading || dialog) : title;
    }

    function checkDialogs() {
        s.dialogTimer = null;
        if (!running()) return;
        const now = Array.from(doc.querySelectorAll(DIALOG));
        for (const dialog of now) {
            if (s.dialogs.some((d) => d.el === dialog)) continue;
            const title = titleOf(dialog);
            s.dialogs.push({ el: dialog, title });
            emitMark('dialog', dialogPayload(true, title));
        }
        s.dialogs = s.dialogs.filter((d) => {
            if (now.includes(d.el)) return true;
            emitMark('dialog', dialogPayload(false, d.title));

            return false;
        });
    }

    function checkDialogsSoon() {
        try {
            if (!s.dialogTimer) s.dialogTimer = win.setTimeout(guard(checkDialogs), 200);
        } catch {
            // no dialog marks on this page
        }
    }

    function watchDialogs(on) {
        try {
            if (!on) {
                s.observer?.disconnect();
                return;
            }
            s.observer ??= new win.MutationObserver(guard(checkDialogsSoon));
            s.observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
            checkDialogsSoon();
        } catch {
            // no dialog marks on this page
        }
    }

    function openChannel() {
        if (s.channel || typeof win.BroadcastChannel !== 'function') return;
        try {
            s.channel = new win.BroadcastChannel(CHANNEL);
            s.channel.onmessage = guard((event) => {
                const reply = replyTo(event.data, s.id);
                if (reply) {
                    s.channel.postMessage(reply);
                } else if (isDuplicate(event.data, s.id, s.pingedAt, Date.now())) {
                    s.pingedAt = 0;
                    if (running()) renew('duplicate');
                    else adopt(mintIdentity(contextOf(), newId));
                }
            });
            s.pingedAt = Date.now();
            s.channel.postMessage(ping(s.id));
        } catch {
            s.channel = null; // without it a duplicated tab may share a recording until its next page load
        }
    }

    /* ── Listeners, once per page load ────────────────────────────────── */

    const on = (target, type, fn, listenerOptions) => {
        try {
            target?.addEventListener(type, guard(fn), listenerOptions);
        } catch {
            // one listener fewer
        }
    };

    on(doc, 'click', (e) => {
        if (!running()) return;
        const el = e.target && typeof e.target.closest === 'function' ? e.target.closest(CONTROL) : null;
        if (!el) return;
        const label = labelOf(el);
        emitMark('press', pressPayload({
            label: s.masking ? mask.text(label, el) : label,
            tag: el.tagName,
            role: el.getAttribute('role'),
            href: el.tagName === 'A' ? el.getAttribute('href') : '',
        }));
    }, true);
    on(win, 'error', (e) => {
        if (running()) emitMark('error', errorPayload(e?.error ?? { name: 'Error', message: e?.message }));
    });
    on(win, 'unhandledrejection', (e) => {
        if (running()) emitMark('error', errorPayload(e?.reason));
    });
    on(doc, 'visibilitychange', () => {
        const hidden = doc.visibilityState === 'hidden';
        emitMark(hidden ? 'hidden' : 'visible', {});
        if (hidden) final(false);
    });
    on(win, 'pagehide', () => {
        emitMark('pagehide', {});
        final(true);
    });
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
        on(win, type, activity, { capture: true, passive: true });
    }
    try {
        win.setInterval(guard(tick), FLUSH_MS);
    } catch {
        // no timer: chunks go on page changes and as the page goes
    }

    /* ── What the host calls ──────────────────────────────────────────── */

    return {
        /** Record this page (and the next ones) while the token allows it. */
        start: guard(start),
        /** Stop before a page that is not to be recorded; what was recorded is still sent. */
        stop: guard(stop),
        /** A mark of the host's own: rrweb custom event `tag` (32 characters at most), its payload masked like text. */
        mark: guard(mark),
        /** A fresh token (from each response, say): who, whether and how this page is recorded. */
        setToken: guard(setToken),
        /** The host's page changed without a page load: a `page` mark {name, url}, and what is buffered goes out. */
        pageChanged: guard((name, url) => {
            s.pageName = name == null || name === '' ? null : String(name);
            if (!running()) return;
            emitMark('page', pagePayload(s.pageName, url ?? here()));
            flush();
        }),
        /** Send what is buffered now (before a deliberate navigation, say). */
        flush: guard(flush),
        /** {id, startedAt (ms)} while recording, else null: @mybeast/errors links an error to its moment with it. */
        currentRecording: () => {
            try {
                return currentRecording();
            } catch {
                return null;
            }
        },
        /**
         * {'X-Recording-Id', 'X-Recording-At'} while recording, else {}: the page's own fetch and XMLHttpRequest get
         * them already (tagRequests); add them by hand to anything else that reaches the host's server.
         */
        requestHeaders: () => {
            try {
                return requestHeaders();
            } catch {
                return {};
            }
        },
        /** {status: off|waiting|recording|paused|refused, recording, upload}: what onChange hears. */
        state: () => {
            try {
                return state();
            } catch {
                return { ...OFF_STATE };
            }
        },
    };
}
