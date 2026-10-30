// The recorder's pure parts: which recording a tab writes to, the tail
// a page leaves for the next one, the marks' payloads, the chunks, the upload address and what an answer means
// (schemas/README.md, "Uploading a chunk" - the contract). recorder.js does the rest.
//
// No browser objects at load, so `node --test` can load it: storage, the clock and crypto come in as arguments.

import { mayRecord } from './client.js';
import { readClaims } from './token.js';

/** sessionStorage keys - per browser tab, kept across a full reload. */
export const KEYS = Object.freeze({
    id: 'mybeast-rec-id', // the recording this tab writes to
    doc: 'mybeast-rec-doc', // how many documents (full page loads) it has had
    last: 'mybeast-rec-last', // the last input (ms)
    start: 'mybeast-rec-start', // when the recording began (ms): maxMinutes, and an error's moment in it
    subject: 'mybeast-rec-subject', // whose it is: the token's sub
    account: 'mybeast-rec-account', // the account it records in: the token's acct ('' for none)
    tail: 'mybeast-rec-tail', // chunks a page could not send before it went (the next page sends them)
});

const MINUTE = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOC = 65_535; // the contract's doc range

export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

/** The recorder's minutes as ms; a missing or odd value takes the default (30 idle, 120 at most). */
export function limitsOf({ idleMinutes, maxMinutes } = {}) {
    const minutes = (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 1 && n <= 24 * 60 ? n : fallback;
    };

    return {
        idleMs: minutes(idleMinutes, 30) * MINUTE,
        maxMs: minutes(maxMinutes, 120) * MINUTE,
    };
}

/** A new recording id: a UUID, as the contract's {recording} expects. */
export function newId(crypto = globalThis.crypto) {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b); // no crypto at all throws: the caller does not record then
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ── Who the recording is for: the token ──────────────────────────────── */

/**
 * What a token says to the recorder, read the way init() reads it: a token of another project (or none, or an
 * unreadable one) is no token - nothing is recorded for someone the page cannot prove. Masked unless the token says
 * mask: false in so many words.
 */
export function authOf(key, token) {
    const read = typeof token === 'string' && token ? readClaims(token) : null;
    const claims = read && read.iss === key ? read : null;

    return {
        token: claims ? token : null,
        subject: typeof claims?.sub === 'string' ? claims.sub : '',
        account: typeof claims?.acct === 'string' ? claims.acct : '',
        recording: mayRecord(claims),
        masked: claims?.mask !== false,
        consentAt: Number.isInteger(claims?.consent_at) ? claims.consent_at : 0,
    };
}

/**
 * The service refuses a chunk whose first event is more than 5 s before consent_at - the server's clock against the
 * browser's. A browser whose clock runs behind would start a recording the service then refuses (403, the end of
 * recording on that page), so the recorder waits until its own clock has passed the yes, with a second to spare.
 */
export const CONSENT_SLACK_MS = 4000;
export const consentReached = (auth, now) => !(auth?.consentAt > 0) || now >= auth.consentAt - CONSENT_SLACK_MS;

/** Two holders the service would file a chunk under alike: the same person, account and masking. */
export const sameHolder = (a, b) => !!a && !!b && !!a.subject && a.subject === b.subject && (a.account ?? '') === (b.account ?? '') && a.masked === b.masked;

/* ── Which recording this tab writes to ───────────────────────────────── */

/** What the tab stored; a storage the browser refuses reads as nothing stored. */
export function readIdentity(store) {
    const get = (key) => {
        try {
            return store?.getItem(key) ?? null;
        } catch {
            return null;
        }
    };
    const num = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };

    return {
        id: get(KEYS.id) || null,
        doc: num(get(KEYS.doc)),
        last: num(get(KEYS.last)),
        start: num(get(KEYS.start)),
        subject: get(KEYS.subject) ?? '',
        account: get(KEYS.account) ?? '',
    };
}

/** Keep the identity in the tab; false when the browser refuses (the page then records without it). */
export function writeIdentity(store, identity) {
    try {
        if (!store) return false;
        store.setItem(KEYS.id, identity.id);
        store.setItem(KEYS.doc, String(identity.doc));
        store.setItem(KEYS.last, String(identity.last));
        store.setItem(KEYS.start, String(identity.start));
        store.setItem(KEYS.subject, identity.subject ?? '');
        store.setItem(KEYS.account, identity.account ?? '');

        return true;
    } catch {
        return false;
    }
}

/**
 * Why the tab needs a new recording, or '' to carry on: none yet, idleMinutes without input, maxMinutes since it
 * began (or the contract's last document), another person, another account. `ctx` is {now, idleMs, maxMs, subject,
 * account}. The service binds a recording to its first chunk's subject and account for good, so either one changing
 * is a new recording, never a mix.
 */
export function renewReason(stored, ctx) {
    if (!isUuid(stored?.id)) return 'new';
    if (!(stored.last > 0) || ctx.now - stored.last > ctx.idleMs) return 'idle';
    if (!(stored.start > 0) || ctx.now - stored.start > ctx.maxMs || stored.doc >= MAX_DOC) return 'max';
    if ((stored.subject ?? '') !== (ctx.subject ?? '')) return 'subject';
    if ((stored.account ?? '') !== (ctx.account ?? '')) return 'account';

    return '';
}

/** A recording begins: document 1, started and last touched now. */
export function mintIdentity(ctx, makeId = newId) {
    return { id: makeId(), doc: 1, last: ctx.now, start: ctx.now, subject: ctx.subject ?? '', account: ctx.account ?? '' };
}

/**
 * A full page load's identity: the tab's recording goes on as its next document, unless renewReason() says a new one
 * begins. Returns {identity, reason}.
 */
export function identityForDocument(stored, ctx, makeId = newId) {
    const reason = renewReason(stored, ctx);
    if (reason) return { identity: mintIdentity(ctx, makeId), reason };

    return { identity: { ...stored, doc: stored.doc + 1 }, reason: '' };
}

/* ── Duplicated tabs (they copy sessionStorage) ───────────────────────── */

export const CHANNEL = 'mybeast-rec';

/** A page that starts recording asks the other tabs whether one of them writes to its id. */
export const ping = (id) => ({ kind: 'ping', id });

/** This tab's answer to another tab's message: 'same' when that tab starts on this tab's recording, else null. */
export function replyTo(message, myId) {
    if (message?.kind === 'ping' && isUuid(message.id) && message.id === myId) return { kind: 'same', id: myId };

    return null;
}

/** Another live tab already writes to this id (an answer within 10 s of the ping): this tab takes a new one. */
export function isDuplicate(message, myId, pingedAt, now) {
    return message?.kind === 'same' && message.id === myId && pingedAt > 0 && now - pingedAt < 10_000;
}

/* ── What leaves the browser unmasked ─────────────────────────────────── */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function dropDataPage(root) {
    const stack = root ? [root] : [];
    while (stack.length) {
        const node = stack.pop();
        if (node.attributes && hasOwn(node.attributes, 'data-page')) delete node.attributes['data-page'];
        const kids = node.childNodes;
        if (kids) for (let i = 0; i < kids.length; i++) if (kids[i]) stack.push(kids[i]);
    }
}

/**
 * The unmasked recording's only cleaning: Inertia's `data-page` attribute out of an rrweb event (full snapshots,
 * added nodes, attribute changes) - it repeats every prop of the first page, the biggest thing on such a page.
 * Changes the event in place and returns it. (Masked recordings go through mask.js's sanitizer instead.)
 */
export function scrubEvent(event) {
    if (!event || typeof event !== 'object' || !event.data) return event;
    if (event.type === 2) {
        dropDataPage(event.data.node); // FullSnapshot
    } else if (event.type === 3 && event.data.source === 0) {
        // IncrementalSnapshot: Mutation
        for (const add of event.data.adds || []) dropDataPage(add?.node);
        for (const change of event.data.attributes || []) {
            if (change?.attributes && hasOwn(change.attributes, 'data-page')) delete change.attributes['data-page'];
        }
    }

    return event;
}

/* ── The marks' payloads (recording-chunk.schema.json lists them) ─────── */

/** Whitespace folded, at most `max` characters. */
export function words(value, max = 80) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** A URL (a URL object or a string) as path + query; masked recordings keep only the path (mask.js). */
export function urlText(url) {
    if (!url) return '';
    if (typeof url === 'object' && typeof url.pathname === 'string') return `${url.pathname}${url.search || ''}`.slice(0, 500);

    return String(url).slice(0, 500);
}

/**
 * `env`: what the screen was like as a document (or a new recording in it) began. `facts` = {path, w, h, dpr, lang,
 * theme, className} read from the page; `translated` when the browser translated it (Chrome adds translated-ltr).
 */
export function envPayload(facts, doc, { rotated = false, masked = true } = {}) {
    const out = {
        path: String(facts?.path ?? '').slice(0, 500),
        w: Number(facts?.w) || 0,
        h: Number(facts?.h) || 0,
        dpr: Number(facts?.dpr) || 1,
        lang: words(facts?.lang, 10),
        theme: words(facts?.theme, 10),
        translated: /\btranslated-(ltr|rtl)\b/.test(String(facts?.className ?? '')),
        doc,
        masked,
    };
    if (rotated) out.rotated = true;

    return out;
}

/** `page`: the host's page changed - its own name for it (a route or component, never a title) and the address. */
export const pagePayload = (name, url) => ({ name: name == null || name === '' ? null : String(name).slice(0, 120), url: url ? urlText(url) : null });

/** `visit`: a request the page started or finished ({method, url, completed?, cancelled?, interrupted?}). */
export function visitPayload(phase, visit) {
    const out = { phase: phase === 'finish' ? 'finish' : 'start', method: String(visit?.method || 'get').toLowerCase(), url: urlText(visit?.url) };
    if (out.phase === 'finish') {
        out.completed = Boolean(visit?.completed);
        out.cancelled = Boolean(visit?.cancelled);
        if (visit?.interrupted) out.interrupted = true;
    }

    return out;
}

/**
 * `refused`: the server sent a form back. `errors` is {field: message | [messages] | {..}}: the field names (at most
 * 20) and the first message - kept in a masked recording only when it is an i18n key ("rules.email").
 */
export function refusedPayload(errors) {
    const bag = errors && typeof errors === 'object' ? errors : {};
    const fields = Object.keys(bag);
    const first = fields.length ? bag[fields[0]] : '';
    const message = words(Array.isArray(first) ? first[0] : typeof first === 'object' && first ? Object.values(first)[0] : first, 120);

    return { fields: fields.slice(0, 20).map((f) => f.slice(0, 80)), ...(message ? { first: message } : {}) };
}

/** `press`: a control the person pressed. `facts` = {label, tag, role, href} read from the element. */
export function pressPayload(facts) {
    return {
        label: words(facts?.label, 80),
        tag: String(facts?.tag ?? '').toLowerCase().slice(0, 20),
        role: words(facts?.role, 30),
        href: String(facts?.href ?? '').slice(0, 300),
    };
}

/** `dialog`: a dialog opened or closed. */
export const dialogPayload = (open, title) => ({ open: Boolean(open), title: words(title, 80) });

/** `error`: an error in the page (an Error, a rejection's reason - anything). Its name and message only, short. */
export function errorPayload(value) {
    if (value && typeof value === 'object') {
        return { name: words(value.name || 'Error', 80), message: words(typeof value.message === 'string' ? value.message : '', 300) };
    }

    return { name: 'Error', message: words(value, 300) };
}

/* ── Chunks and the upload ────────────────────────────────────────────── */

/** Raw characters per chunk: well inside the contract's 16 MiB unpacked / 2 MiB sent. */
export const MAX_CHUNK_CHARS = 4_000_000;

/** Events as JSON arrays of at most `maxChars` (halved until they fit; one event too big still goes alone). */
export function packEvents(events, maxChars = MAX_CHUNK_CHARS) {
    const out = [];
    const pack = (list) => {
        const json = JSON.stringify(list);
        if (json.length <= maxChars || list.length < 2) {
            out.push(json);

            return;
        }
        const half = Math.ceil(list.length / 2);
        pack(list.slice(0, half));
        pack(list.slice(half));
    };
    if (Array.isArray(events) && events.length) pack(events);

    return out;
}

/** A chunk the service found too big (413), in two halves; null when it is one event (it can only be dropped). */
export function splitJson(json) {
    try {
        const events = JSON.parse(json);
        if (!Array.isArray(events) || events.length < 2) return null;
        const half = Math.ceil(events.length / 2);

        return [JSON.stringify(events.slice(0, half)), JSON.stringify(events.slice(half))];
    } catch {
        return null;
    }
}

/** POST target of one chunk: {url}/v1/parts/{recording}?key=&t=&doc=&seq= - the public key and token ride the query. */
export function chunkUrl({ url, key, token = null }, { id, doc, seq }) {
    const target = new URL(`${String(url).replace(/\/+$/, '')}/v1/parts/${encodeURIComponent(id)}`);
    target.searchParams.set('key', key);
    if (token) target.searchParams.set('t', token);
    target.searchParams.set('doc', String(doc));
    target.searchParams.set('seq', String(seq));

    return target.toString();
}

/**
 * The fetch options of one upload: a CORS-simple POST - a safelisted content type, no credentials, no custom header -
 * because the last chunk of a page rides keepalive, and a request that needs a preflight does not survive the page
 * going away. The Referer carries only the origin: the page's query is nobody's business.
 */
export function uploadInit(body, keepalive = false) {
    return {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive,
        referrerPolicy: 'strict-origin',
        headers: { 'Content-Type': 'text/plain' },
        body,
    };
}

/**
 * What an upload's answer means (the contract's table):
 * stored (2xx: a repeated doc/seq too, the first write wins) · refresh (401: the token does not hold - ask the host
 * for a fresh one, send again) · stop (402: the project's subscription has ended; 403: not this origin, key or yes;
 * but a chunk from before the yes, `refused: before-consent`, is only dropped - the next one may well be after it) · rotate (404 the id is another subject's;
 * 409 another account's: a new recording) · split (413) · retry (no answer, 408, 425, 429, 5xx: 3 tries) · drop
 * (422 not storable or a leak; any other answer the contract does not name).
 */
export function answerFor(status, refused = null) {
    if (status >= 200 && status < 300) return 'stored';
    if (status === 401) return 'refresh';
    if (status === 402) return 'stop';
    if (status === 403) return refused === 'before-consent' ? 'drop' : 'stop';
    if (status === 404 || status === 409) return 'rotate';
    if (status === 413) return 'split';
    if (!status || status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';

    return 'drop';
}

/** gzip of a string with the browser's own CompressionStream (Node has it too). */
export async function gzip(text) {
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    writer.write(new TextEncoder().encode(text)).catch(() => {});
    writer.close().catch(() => {});
    const reader = stream.readable.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.byteLength;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }

    return out;
}

/* ── The tail: what a page leaves for the next one in the tab ─────────── */

/** At most this many characters wait in the tab (sessionStorage holds about 5 MB per site); the oldest go first. */
export const TAIL_MAX_CHARS = 2_000_000;

const sameChunk = (a, b) => a.id === b.id && a.doc === b.doc && a.seq === b.seq;
const validTail = (t) => t && isUuid(t.id) && Number.isInteger(t.doc) && Number.isInteger(t.seq) && typeof t.json === 'string';

function readTails(store) {
    const raw = store?.getItem(KEYS.tail);
    if (!raw) return [];
    const list = JSON.parse(raw);

    return Array.isArray(list) ? list.filter(validTail) : [];
}

/**
 * Leave a chunk {id, doc, seq, json, subject, account, masked} in the tab; true when it is there. The token stays
 * out: the next page sends it with its own.
 */
export function pushTail(store, chunk) {
    try {
        if (!store || !validTail(chunk)) return false;
        const list = readTails(store).filter((t) => !sameChunk(t, chunk));
        list.push({
            id: chunk.id,
            doc: chunk.doc,
            seq: chunk.seq,
            json: chunk.json,
            subject: typeof chunk.subject === 'string' ? chunk.subject : '',
            account: typeof chunk.account === 'string' ? chunk.account : '',
            masked: chunk.masked !== false,
        });
        let total = list.reduce((n, t) => n + t.json.length, 0);
        while (total > TAIL_MAX_CHARS && list.length) total -= list.shift().json.length;
        if (!list.length) {
            store.removeItem(KEYS.tail);

            return false;
        }
        store.setItem(KEYS.tail, JSON.stringify(list));

        return list.some((t) => sameChunk(t, chunk));
    } catch {
        return false;
    }
}

/** Take one chunk back out (it is about to be sent another way); true when it was there. */
export function dropTail(store, chunk) {
    try {
        const list = readTails(store);
        const rest = list.filter((t) => !sameChunk(t, chunk));
        if (rest.length === list.length) return false;
        if (rest.length) store.setItem(KEYS.tail, JSON.stringify(rest));
        else store.removeItem(KEYS.tail);

        return true;
    } catch {
        return false;
    }
}

/**
 * Only the leftovers the token on this page can send: the same person, account and masking. Another person signed
 * in on the tab, or a chunk without its holder, is never sent - it would be filed as whoever is signed in now.
 */
export const tailsOf = (tails, holder) => (holder?.subject ? tails.filter((t) => sameHolder(t, holder)) : []);

/** Everything waiting in the tab, taken out of it (the caller sends what is its to send). */
export function takeTails(store) {
    let list = [];
    try {
        list = readTails(store);
    } catch {
        list = [];
    }
    try {
        store?.removeItem(KEYS.tail);
    } catch {
        // refused storage: nothing was there to take
    }

    return list;
}

/* ── Timing ───────────────────────────────────────────────────────────── */

/** Run when the browser is idle (Safari has no requestIdleCallback: a short timer instead). */
export function whenIdle(fn, timeout = 2000, scope = globalThis) {
    if (typeof scope.requestIdleCallback === 'function') return scope.requestIdleCallback(fn, { timeout });

    const ms = Math.min(timeout, 1500);
    // Called on its window: a detached window.setTimeout throws "Illegal invocation".
    return typeof scope.setTimeout === 'function' ? scope.setTimeout(fn, ms) : setTimeout(fn, ms);
}
