// The masking engine: what a masked recording keeps readable. Fail
// closed: text, an attribute or a mark the rules do not know is hidden, and an event the sanitizer cannot read never
// leaves the page.
//
//   1 inputs - every value masked (rrweb's maskAllInputs); hidden and file inputs' values dropped here
//   2 media, and every svg that is not aria-hidden, blocked (rrweb keeps an empty box of the same size)
//   3 inside a private selector ([data-mybeast-private], [translate="no"], the host's own) every word is masked,
//     the host's own words too: a "Late" on a person's card says something about that person
//   4 other text stays only if it IS one of the host's own words (its dictionary); no dictionary masks every word
//   5 attributes allow-listed; URLs keep their path, never ?query or #hash; mailto:/tel: keep only the scheme
//   6 ids out of every URL and attribute: UUIDs, ULIDs, digits, and the host's own id patterns
//
// No browser objects at load, so `node --test` can load it.

/**
 * Rule 3: inside these every word is masked. `[data-insights-private]` is an older name, kept
 * as an alias so markup that uses it keeps working.
 */
export const PRIVATE_SELECTORS = Object.freeze(['[data-mybeast-private]', '[translate="no"]', '[data-insights-private]']);
export const PRIVATE_SELECTOR = PRIVATE_SELECTORS.join(', ');

/**
 * Rule 2: blocked, whatever the mode is masked or not for media. A graphic inside a private node draws that node's
 * data, so createMask() adds `<private selector> svg` for each private selector. An iframe's own document is dropped
 * by the sanitizer (rrweb records a blocked same-origin frame anyway).
 */
export const BLOCK_SELECTORS = Object.freeze([
    'img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed',
    'svg:not([aria-hidden="true"])', '[data-mybeast-block]', '[data-insights-block]',
]);
export const BLOCK_SELECTOR = [...BLOCK_SELECTORS, ...PRIVATE_SELECTORS.map((p) => `${p} svg`)].join(', ');

/** Every non-space character as a star: the layout keeps its shape, the words go. */
export const star = (value) => String(value).replace(/\S/g, '*');

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// A RegExp without g/y: .test() on it keeps no state between calls.
const once = (re) => new RegExp(re.source, re.flags.replace(/[gy]/g, ''));

/* ── Rule 4: the host's own words ─────────────────────────────────────── */

/** Keys whose values are made-up people ("Matti", "virtanen@example.com"): a real person may share them, never kept. */
export const EXAMPLE_KEY = /placeholder|example|sample|demo/i;

/**
 * Every string of a host's dictionaries, for buildUiMasker(): an array of strings, nested objects of them (i18next
 * resources, one per language), or an array of either. Values under keys that name made-up examples (EXAMPLE_KEY) are
 * left out, and so is anything `skip` (a RegExp, tested on each key and each string) matches - the host's words that
 * would say something about the person they show beside ("housing allowance" next to a tenancy).
 */
export function uiStrings(source, { skip = null, examples = EXAMPLE_KEY } = {}) {
    const out = new Set();
    const skipRe = skip instanceof RegExp ? once(skip) : null;
    const exampleRe = examples instanceof RegExp ? once(examples) : null;
    const skipped = (text) => skipRe !== null && skipRe.test(text);
    const walk = (value, key, depth) => {
        if (depth > 32) return; // a cycle, or a dictionary nobody writes by hand
        if (key !== null && ((exampleRe && exampleRe.test(key)) || skipped(key))) return;
        if (typeof value === 'string') {
            if (!skipped(value)) out.add(value);
        } else if (Array.isArray(value)) {
            for (const item of value) walk(item, null, depth + 1);
        } else if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) walk(v, k, depth + 1);
        }
    };
    walk(source, null, 0);

    return [...out];
}

/**
 * (text) => text with only the dictionary's words readable. A text is kept when, whitespace folded, it equals a
 * string (any case); one that matches a template ("{{count}} open") keeps the literal words and masks what was filled
 * in; digits alone are masked even when a string is "2"; everything else is masked character by character, so the
 * layout keeps its shape. The parts between <tags> (react-i18next's Trans) count as strings of their own.
 */
export function buildUiMasker(strings) {
    const exact = new Set();
    const exactLower = new Set();
    const buckets = new Map();
    const loose = [];
    const seen = new Set();
    const push = (key, entry) => {
        const list = buckets.get(key);
        if (list) list.push(entry);
        else buckets.set(key, [entry]);
    };

    for (const raw of Array.isArray(strings) ? strings : []) {
        if (typeof raw !== 'string') continue;
        for (const part of raw.split(/<\/?[A-Za-z0-9]+\s*\/?>/)) {
            const s = norm(part);
            if (!s) continue;
            if (!s.includes('{{')) {
                exact.add(s);
                exactLower.add(s.toLowerCase());
                continue;
            }
            if (seen.has(s)) continue;
            seen.add(s);
            const lits = s.split(/\{\{[^}]*\}\}/);
            // A template with no words of its own ("{{a}} {{b}}") would match anything: never a reason to keep text.
            if (!lits.some((l) => /\p{L}{2,}/u.test(l))) continue;
            const entry = { lits, re: null, src: `^${lits.map(esc).join('(.+?)')}$` };
            const first = lits[0];
            const last = lits[lits.length - 1];
            if (first.length >= 3) push(`p:${first.slice(0, 3)}`, entry);
            else if (last.length >= 3) push(`s:${last.slice(-3)}`, entry);
            else {
                entry.frag = lits.reduce((a, b) => (b.length > a.length ? b : a), '');
                loose.push(entry);
            }
        }
    }

    const tryTemplates = (s, list) => {
        if (!list) return null;
        for (const e of list) {
            if (e.frag && !s.includes(e.frag)) continue;
            e.re ??= new RegExp(e.src, 's');
            const m = e.re.exec(s);
            if (!m) continue;
            let out = e.lits[0];
            for (let i = 1; i < e.lits.length; i++) out += star(m[i]) + e.lits[i];

            return out;
        }

        return null;
    };

    return (text) => {
        if (text == null) return text;
        const t = String(text);
        if (!/[\p{L}\p{N}]/u.test(t)) return t; // whitespace, punctuation, symbols, stars
        if (!/\p{L}/u.test(t)) return star(t); // digits alone are data: counts, amounts, flat numbers, years
        const s = norm(t);
        if (exact.has(s) || exactLower.has(s.toLowerCase())) return t;
        const out = tryTemplates(s, buckets.get(`p:${s.slice(0, 3)}`))
            ?? tryTemplates(s, buckets.get(`s:${s.slice(-3)}`))
            ?? tryTemplates(s, loose);
        if (out !== null) return t.match(/^\s*/)[0] + out + t.match(/\s*$/)[0];

        return star(t);
    };
}

/**
 * Rule 4 from the recorder's options: (text) => text. `readable(text)` returning true keeps a text as it is (the
 * host's own judge); otherwise the dictionary decides - an array or nested objects of strings, or a function that
 * returns them, read once on first use (a host's i18n may load after the recorder). Neither: every word is masked.
 * A dictionary or a predicate that throws keeps nothing.
 */
export function createTextMask({ dictionary = null, readable = null } = {}) {
    let byWords = null;
    const words = () => {
        if (byWords) return byWords;
        let strings = [];
        try {
            strings = uiStrings(typeof dictionary === 'function' ? dictionary() : dictionary);
        } catch {
            strings = [];
        }
        byWords = buildUiMasker(strings);

        return byWords;
    };

    return (text) => {
        if (text == null) return text;
        const t = String(text);
        if (typeof readable === 'function') {
            try {
                if (readable(t) === true) return t;
            } catch {
                // the host's judge failed: the dictionary decides
            }
        }

        return words()(t);
    };
}

/**
 * rrweb's maskTextFn (text, the text's parent element): rule 3 on the live page, rule 4 elsewhere. Without an element
 * (rrweb has none for a few nodes), or with a selector the browser cannot read, the text is treated as private.
 */
export function textMasker(ui, privateSelector = PRIVATE_SELECTOR) {
    return (text, element) => {
        if (text == null) return text;
        let inside = true;
        try {
            inside = !element || typeof element.closest !== 'function' || element.closest(privateSelector) !== null;
        } catch {
            inside = true;
        }

        return inside ? star(text) : ui(text);
    };
}

/* ── Rules 5 and 6: URLs and ids ──────────────────────────────────────── */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ULID = '\\b[0-9A-HJKMNP-TV-Z]{26}\\b';
const ROUTE_WORD = /^[a-z][a-z0-9_-]{0,40}$/;

/**
 * What counts as an id, and which path segments stay: UUIDs and ULIDs always, plus the host's `idPatterns` (RegExps:
 * an order number, a customer code). A path segment stays when it is a route word - by default any lowercase word
 * (`/properties`, `/new`); `routeWords` (a list, or a predicate) narrows that for a host whose URLs carry name slugs
 * (`/u/liisa-virtanen`). Built once; the url helpers take it as their last argument.
 */
export function urlRules({ idPatterns = [], routeWords = null } = {}) {
    const list = [new RegExp(UUID, 'i'), new RegExp(ULID), ...(Array.isArray(idPatterns) ? idPatterns : []).filter((p) => p instanceof RegExp)];
    const keep = typeof routeWords === 'function'
        ? routeWords
        : Array.isArray(routeWords)
            ? ((words) => (s) => words.has(s))(new Set(routeWords))
            : (s) => ROUTE_WORD.test(s);

    return {
        anywhere: list.map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags.replace('y', '') : `${re.flags.replace('y', '')}g`)),
        whole: list.map((re) => new RegExp(`^(?:${re.source})$`, re.flags.replace(/[gy]/g, ''))),
        keep,
    };
}

const DEFAULT_RULES = urlRules();

/** Ids out of a text that is otherwise kept (an `id`, a class, a style): the replay must not resolve them. */
export function dropIds(value, rules = DEFAULT_RULES) {
    let out = String(value);
    for (const re of rules.anywhere) out = out.replace(re, ':id');

    return out;
}

/** One path segment: a route word stays, an id becomes `:id`, anything else (a name, a file) `:x`. */
function segment(seg, rules) {
    if (seg === '') return seg;
    let s = seg;
    try {
        s = decodeURIComponent(seg);
    } catch {
        return ':x';
    }
    if (/^\d+$/.test(s) || rules.whole.some((re) => re.test(s))) return ':id';
    let keep = false;
    try {
        keep = rules.keep(s) === true;
    } catch {
        keep = false;
    }

    return keep ? seg : ':x';
}

/**
 * A URL as the recording may hold it: http(s) and relative URLs keep their path - route words only, ids as `:id` -
 * without ?query or #hash; any other scheme (mailto:, tel:, data:, blob:, javascript:) keeps only its scheme.
 * Comma lists (srcset) are taken part by part.
 */
export function maskUrl(value, rules = DEFAULT_RULES) {
    return String(value ?? '').split(',').map((part) => {
        const p = part.trim();
        if (!p) return part;
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(p);
        if (scheme && !/^https?$/i.test(scheme[1])) return `${scheme[1]}:`;
        const [head, descriptor = ''] = p.split(/\s+/, 2);
        const noTail = head.replace(/[?#].*$/, '');
        const origin = /^(?:https?:)?\/\/[^/]+/i.exec(noTail)?.[0] ?? '';
        const path = noTail.slice(origin.length).split('/').map((seg) => segment(seg, rules)).join('/');

        return `${origin}${path}${descriptor && /^\d+(\.\d+)?[wx]$/.test(descriptor) ? ` ${descriptor}` : ''}`;
    }).join(',');
}

/** url(...) inside a style through maskUrl (an avatar's file name, an id in a path), and ids out of the rest. */
export const maskCssUrls = (style, rules = DEFAULT_RULES) => dropIds(
    String(style).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, q, url) => `url(${q}${maskUrl(url, rules)}${q})`),
    rules,
);

/**
 * Free text that has to stay readable for debugging (an error's message, a page name): e-mail addresses, ids, IBANs,
 * Finnish personal ids and runs of five or more digits are masked, the rest kept.
 */
export function scrubFreeText(value, max = 300, rules = DEFAULT_RULES) {
    return dropIds(String(value ?? '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => star(m)), rules)
        .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g, (m) => star(m))
        .replace(/\b\d{6}[-+A-FU-Y]\d{3}[0-9A-Y]\b/g, (m) => star(m))
        .replace(/\d[\d\s-]{3,}\d/g, (m) => (m.replace(/\D/g, '').length >= 5 ? star(m) : m))
        .slice(0, max);
}

/* ── Selectors on rrweb's serialized nodes ────────────────────────────── */

/** A selector list split at its top-level commas (not those inside [..], (..) or quotes). */
export function splitSelectors(selector) {
    const out = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    const s = String(selector ?? '');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[' || c === '(') depth++;
        else if (c === ']' || c === ')') depth--;
        else if (c === ',' && depth === 0) {
            out.push(s.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(s.slice(start).trim());

    return out.filter(Boolean);
}

/** The last compound of a complex selector (`.card [data-x]` -> `[data-x]`). */
function lastCompound(selector) {
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < selector.length; i++) {
        const c = selector[i];
        if (quote) {
            if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[' || c === '(') depth++;
        else if (c === ']' || c === ')') depth--;
        else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) start = i + 1;
    }

    return selector.slice(start).trim();
}

const PART = /^(?:([a-zA-Z][\w-]*|\*)|\.([\w-]+)|#([\w-]+)|\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\])/;

function compileCompound(compound) {
    const test = [];
    let rest = compound;
    while (rest) {
        const m = PART.exec(rest);
        if (!m) return null; // a pseudo-class or anything else: not judged here (the live page still applies it)
        rest = rest.slice(m[0].length);
        const [, tag, cls, id, attr, op, v1, v2, v3] = m;
        if (tag) {
            if (tag !== '*') test.push((t) => t === tag.toLowerCase());
        } else if (cls) {
            test.push((t, a) => typeof a.class === 'string' && a.class.split(/\s+/).includes(cls));
        } else if (id) {
            test.push((t, a) => a.id === id);
        } else {
            const name = attr.toLowerCase();
            const want = v1 ?? v2 ?? v3 ?? '';
            const value = (a) => (a[name] === true ? '' : String(a[name]));
            const ops = {
                '=': (v) => v === want,
                '~=': (v) => v.split(/\s+/).includes(want),
                '|=': (v) => v === want || v.startsWith(`${want}-`),
                '^=': (v) => want !== '' && v.startsWith(want),
                '$=': (v) => want !== '' && v.endsWith(want),
                '*=': (v) => want !== '' && v.includes(want),
            };
            test.push((t, a) => hasOwn(a, name) && a[name] !== null && a[name] !== false && (!op || ops[op](value(a))));
        }
    }

    return test.length ? (t, a) => test.every((fn) => fn(t, a)) : null;
}

/**
 * (tagName, attributes) => true when an rrweb serialized node matches one of the selectors. Simple selectors only -
 * tag, .class, #id, [attr], [attr=value] (and ~= |= ^= $= *=) - and of a complex one only its last part, which
 * matches more nodes than the selector does: on the safe side, since a private node's descendants are private anyway.
 */
export function nodeMatcher(selector) {
    const tests = splitSelectors(selector).map((s) => compileCompound(lastCompound(s))).filter(Boolean);

    return (tagName, attributes) => {
        const t = String(tagName ?? '').toLowerCase();
        const a = attributes && typeof attributes === 'object' ? attributes : {};

        return tests.some((fn) => fn(t, a));
    };
}

/* ── Attributes (rule 5), the event stream ────────────────────────────── */

// Structural and state attributes whose values are no one's data.
const KEEP = new Set([
    'class', 'style', 'id', 'role', 'type', 'name', 'for', 'tabindex', 'dir', 'lang', 'translate', 'hidden', 'disabled',
    'checked', 'selected', 'readonly', 'required', 'multiple', 'open', 'colspan', 'rowspan', 'span', 'width', 'height',
    'size', 'rel', 'media', 'charset', 'as', 'async', 'defer', 'nomodule', 'crossorigin', 'loading', 'decoding',
    'fetchpriority', 'referrerpolicy', 'target', 'draggable', 'contenteditable', 'spellcheck', 'autocomplete',
    'autocapitalize', 'autocorrect', 'inputmode', 'enterkeyhint', 'maxlength', 'minlength', 'min', 'max', 'step',
    'pattern', 'accept', 'form', 'formnovalidate', 'novalidate', 'method', 'inert', 'start', 'reversed', 'scope',
    'headers', 'xmlns', 'viewbox', 'aria-expanded', 'aria-selected', 'aria-current', 'aria-hidden', 'aria-disabled',
    'aria-pressed', 'aria-checked', 'aria-busy', 'aria-invalid', 'aria-modal', 'aria-orientation', 'aria-haspopup',
    'aria-live', 'aria-atomic', 'aria-relevant', 'aria-level', 'aria-posinset', 'aria-setsize', 'aria-sort',
    'aria-colcount', 'aria-rowcount', 'aria-colindex', 'aria-rowindex', 'aria-colspan', 'aria-rowspan',
    'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-errormessage',
    'aria-required', 'aria-readonly', 'aria-multiselectable', 'aria-autocomplete', 'aria-valuemin', 'aria-valuemax',
    'aria-valuenow', 'aria-keyshortcuts', 'data-mybeast-private', 'data-mybeast-block', 'data-insights-private',
    'data-insights-block',
]);
// Data attributes component libraries style on by value (Radix, Headless UI and the like): masked, the replay would
// lose its open menus and pressed tabs. A host adds its own with `keepAttributes`.
const KEEP_DATA = [
    'data-state', 'data-theme', 'data-side', 'data-align', 'data-orientation', 'data-disabled', 'data-highlighted',
    'data-selected', 'data-open', 'data-active', 'data-variant', 'data-size', 'data-headlessui-state',
];
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'xlink:href', 'cite', 'background', 'ping', 'data']);
// Inputs whose value rrweb's maskAllInputs already masks; any other input's value goes through rule 4.
const MASKED_INPUTS = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'number', 'password', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']);
const SVG_KEEP = /^(?!aria-label$|aria-description$|title$|alt$|data-).*/;

// rrweb's IncrementalSource values that carry no one's text: mouse, clicks, scroll, resize, touch, media, drag,
// selection (node ids only), custom element names. Mutation (0) and Input (5) are cleaned, the stylesheet ones (8, 13,
// 15) keep their CSS with URLs and ids out, and anything else (canvas, fonts, console logs) never leaves.
const PLAIN_SOURCES = new Set([1, 2, 3, 4, 6, 7, 12, 14, 16]);
// A control's chosen state: inside a private node it would say which of a person's options is theirs.
const CHOICE = ['checked', 'selected', 'aria-checked', 'aria-pressed', 'aria-selected'];

/** A style change rrweb sent as a diff ({property: value | [value, priority] | false}), its URLs and ids out. */
function maskStyleDiff(diff, rules) {
    for (const prop of Object.keys(diff)) {
        const value = diff[prop];
        if (typeof value === 'string') diff[prop] = maskCssUrls(value, rules);
        else if (Array.isArray(value) && typeof value[0] === 'string') value[0] = maskCssUrls(value[0], rules);
    }
}

/** CSS a page added while running (StyleSheetRule, StyleDeclaration, AdoptedStyleSheet): URLs and ids out. */
function maskCssEvent(d, rules) {
    for (const add of d.adds || []) if (add && typeof add.rule === 'string') add.rule = maskCssUrls(add.rule, rules);
    if (d.set && typeof d.set.value === 'string') d.set.value = maskCssUrls(d.set.value, rules);
    for (const sheet of d.styles || []) {
        for (const rule of sheet?.rules || []) if (rule && typeof rule.rule === 'string') rule.rule = maskCssUrls(rule.rule, rules);
    }
}

const isClassName = (value) => typeof value === 'string' && /^[A-Z][A-Za-z0-9]{0,40}$/.test(value);
const isKey = (value) => typeof value === 'string' && /^[a-z0-9_]+(\.[A-Za-z0-9_-]+)+$/.test(value);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const code = (value, re, fallback = '') => (typeof value === 'string' && re.test(value) ? value : fallback);

/**
 * The masked recording's sanitizer: (rrweb event) => the event, cleaned in place, or null when it must not leave.
 * `ui` is rule 4 (createTextMask). It remembers what it saw of each node (tag, input type, private), so an attribute
 * or text change later in the recording is judged like the node it lands on.
 */
export function createSanitizer(ui, { privateSelector = PRIVATE_SELECTOR, keepAttributes = [], rules = DEFAULT_RULES } = {}) {
    const isPrivate = nodeMatcher(privateSelector);
    const keep = new Set([...KEEP, ...KEEP_DATA, ...(Array.isArray(keepAttributes) ? keepAttributes : []).map((n) => String(n).toLowerCase())]);
    let nodes = new Map();
    let gone = new Set(); // an iframe's document and everything in it: never sent

    const words = (value, priv) => (priv ? star(value) : ui(dropIds(value, rules)));
    const url = (value) => maskUrl(value, rules);
    const drop = (node) => {
        if (!node) return;
        gone.add(node.id);
        for (const child of node.childNodes || []) drop(child);
    };

    function attributes(info, attrs) {
        if (!attrs) return;
        if (info.priv) for (const name of CHOICE) delete attrs[name];
        for (const name of Object.keys(attrs)) {
            const value = attrs[name];
            if (name === 'data-page') {
                delete attrs[name]; // Inertia's first page, every prop of it
                continue;
            }
            if (name === 'style' && value && typeof value === 'object') {
                maskStyleDiff(value, rules);
                continue;
            }
            if (typeof value !== 'string') continue; // null removes it; booleans are presence
            if (name === '_cssText' || name.startsWith('rr_')) continue; // inlined CSS, rrweb's own
            if (URL_ATTRS.has(name)) attrs[name] = url(value);
            else if (name === 'style') attrs[name] = maskCssUrls(value, rules);
            else if (name === 'value' && info.tag === 'input') {
                if (info.input === 'hidden' || info.input === 'file') delete attrs[name];
                else if (!MASKED_INPUTS.has(info.input)) attrs[name] = words(value, info.priv);
            } else if (name === 'value' && (info.tag === 'textarea' || info.tag === 'select' || info.tag === 'progress' || info.tag === 'meter')) {
                // rrweb masked textarea/select; progress and meter hold a position, not anyone's value
            } else if (keep.has(name)) attrs[name] = dropIds(value, rules);
            else if (info.svg && SVG_KEEP.test(name)) attrs[name] = dropIds(value, rules); // geometry
            else if (info.tag === 'meta' && name === 'content') attrs[name] = dropIds(value, rules);
            else attrs[name] = words(value, info.priv);
        }
    }

    function walk(node, privParent) {
        if (!node) return;
        if (node.type === 2) {
            const info = {
                tag: String(node.tagName || '').toLowerCase(),
                svg: !!node.isSVG,
                input: String(node.attributes?.type ?? '').toLowerCase(),
                priv: privParent || isPrivate(node.tagName, node.attributes),
            };
            nodes.set(node.id, info);
            attributes(info, node.attributes);
            for (const child of node.childNodes || []) walk(child, info.priv);
        } else if (node.type === 3) {
            nodes.set(node.id, { tag: '#text', priv: privParent });
            if (!node.isStyle && typeof node.textContent === 'string') node.textContent = words(node.textContent, privParent);
        } else if (node.type === 5) {
            node.textContent = ''; // a comment can hold anything
        } else {
            for (const child of node.childNodes || []) walk(child, privParent);
        }
    }

    /** A host's own mark: every string through rule 4, numbers and yes/no kept, at most 3 levels, 20 items, 30 keys. */
    function anyPayload(value, depth = 0) {
        if (typeof value === 'string') return words(value, false).slice(0, 300);
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'boolean' || value === null) return value;
        if (depth >= 3 || typeof value !== 'object') return null;
        if (Array.isArray(value)) return value.slice(0, 20).map((v) => anyPayload(v, depth + 1));
        const out = {};
        for (const key of Object.keys(value).slice(0, 30)) out[dropIds(key, rules).slice(0, 60)] = anyPayload(value[key], depth + 1);

        return out;
    }

    /** The marks: a built-in one keeps its own fields, each judged; a host's own goes through anyPayload. */
    function custom(data) {
        const p = data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) ? data.payload : {};
        const text = (value, max = 80) => (typeof value === 'string' ? words(value, false).slice(0, max) : '');
        const href = (value) => (typeof value === 'string' ? url(value) : '');
        switch (data.tag) {
            case 'env':
                data.payload = {
                    path: href(p.path),
                    w: num(p.w),
                    h: num(p.h),
                    dpr: num(p.dpr) || 1,
                    lang: code(p.lang, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
                    theme: code(p.theme, /^[a-z0-9_-]{1,20}$/),
                    translated: p.translated === true,
                    ...(p.rotated === true ? { rotated: true } : {}),
                    doc: num(p.doc),
                    masked: true,
                };
                break;
            case 'page':
                // The host's page name: a route or component name, never a title - still, no address or id in it.
                data.payload = { name: typeof p.name === 'string' ? scrubFreeText(p.name, 120, rules) : null, url: href(p.url) || null };
                break;
            case 'visit':
                data.payload = {
                    phase: p.phase === 'finish' ? 'finish' : 'start',
                    method: code(typeof p.method === 'string' ? p.method.toLowerCase() : '', /^[a-z]{1,10}$/, 'get'),
                    url: href(p.url),
                    ...(p.phase === 'finish' ? { completed: p.completed === true, cancelled: p.cancelled === true } : {}),
                    ...(p.interrupted === true ? { interrupted: true } : {}),
                };
                break;
            case 'press':
                data.payload = {
                    label: text(p.label),
                    tag: code(p.tag, /^[a-z][a-z0-9-]{0,19}$/),
                    role: code(p.role, /^[a-z]{1,30}$/),
                    href: href(p.href),
                };
                break;
            case 'dialog':
                data.payload = { open: p.open === true, title: text(p.title) };
                break;
            case 'refused':
                // Field names may carry a row's id; the first message is kept only as an i18n key ("rules.email") -
                // anything else is a message someone could have typed into.
                data.payload = {
                    fields: (Array.isArray(p.fields) ? p.fields : []).slice(0, 20).map((field) => dropIds(String(field), rules).slice(0, 80)),
                    ...(typeof p.first === 'string' && p.first ? { first: isKey(p.first) ? p.first.slice(0, 120) : text(p.first, 120) } : {}),
                };
                break;
            case 'error':
                // The error service holds the error itself; here only its kind stays (a rejection can be any object's JSON).
                data.payload = {
                    name: isClassName(p.name) ? p.name : text(p.name),
                    message: typeof p.message === 'string' ? ui(scrubFreeText(p.message, 300, rules)) : '',
                };
                break;
            case 'broken':
                data.payload = { kind: code(p.kind, /^[a-z-]{1,20}$/, 'unknown') };
                break;
            case 'hidden':
            case 'visible':
            case 'pagehide':
                data.payload = {};
                break;
            default:
                data.payload = anyPayload(p);
        }
    }

    return (event) => {
        try {
            if (!event || typeof event !== 'object') return null;
            const d = event.data;
            switch (event.type) {
                case 4: // Meta
                    if (d && typeof d.href === 'string') d.href = url(d.href);
                    break;
                case 2: // FullSnapshot: a new page - the nodes seen before are gone
                    nodes = new Map();
                    gone = new Set();
                    walk(d?.node, false);
                    break;
                case 3: // IncrementalSnapshot
                    if (!d || gone.has(d.id)) return null; // inside an iframe's document
                    if (d.source === 0) { // Mutation
                        if (d.isAttachIframe) { // a same-origin iframe's document: rule 2 blocks iframes
                            for (const add of d.adds || []) drop(add?.node);
                            return null;
                        }
                        // A parent never seen (it comes later in the same list, or before the snapshot) counts as private.
                        d.adds = (d.adds || []).filter((add) => {
                            if (gone.has(add?.parentId)) {
                                drop(add?.node);
                                return false;
                            }
                            walk(add?.node, nodes.get(add?.parentId)?.priv ?? true);

                            return true;
                        });
                        d.removes = (d.removes || []).filter((remove) => !gone.has(remove?.id));
                        d.attributes = (d.attributes || []).filter((change) => !gone.has(change?.id));
                        d.texts = (d.texts || []).filter((text) => !gone.has(text?.id));
                        for (const change of d.attributes) attributes(nodes.get(change?.id) || { tag: '', priv: true }, change?.attributes);
                        for (const text of d.texts) {
                            if (text && typeof text.value === 'string') text.value = words(text.value, nodes.get(text.id)?.priv ?? true);
                        }
                    } else if (d.source === 5) { // Input: typing shows as stars; a private choice keeps no state
                        if (typeof d.text === 'string') d.text = star(d.text);
                        if (nodes.get(d.id)?.priv ?? true) delete d.isChecked;
                    } else if (d.source === 8 || d.source === 13 || d.source === 15) {
                        maskCssEvent(d, rules);
                    } else if (!PLAIN_SOURCES.has(d.source)) {
                        return null;
                    }
                    break;
                case 5: // Custom: the marks
                    if (!d || typeof d.tag !== 'string') return null;
                    custom(d);
                    break;
                case 6: // Plugin: none is on; one added later is not sent until it is judged here
                    return null;
                default: // DomContentLoaded, Load
                    break;
            }

            return event;
        } catch {
            return null; // a sanitizer failure must never let an unsanitized event out
        }
    };
}

/**
 * Everything the recorder masks with, from its options: `dictionary` / `readable` (rule 4), `privateSelectors` and
 * `blockSelectors` (added to the defaults), `keepAttributes`, `idPatterns`, `routeWords`. `validSelector(selector)`
 * (the recorder passes the browser's own check) leaves out a block selector the browser cannot read - rrweb would
 * throw on every node; a private one stays, so a broken one masks everything rather than nothing.
 */
export function createMask(options = {}) {
    const list = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
        .flatMap((s) => (typeof s === 'string' ? splitSelectors(s) : []));
    const valid = typeof options.validSelector === 'function' ? options.validSelector : () => true;
    const privates = [...PRIVATE_SELECTORS, ...list(options.privateSelectors)];
    const privateSelector = privates.join(', ');
    const blockSelector = [...BLOCK_SELECTORS, ...privates.map((p) => `${p} svg`), ...list(options.blockSelectors)]
        .filter((s) => {
            try {
                return valid(s) !== false;
            } catch {
                return false;
            }
        })
        .join(', ');
    const rules = urlRules(options);
    const words = createTextMask(options);
    const keepAttributes = Array.isArray(options.keepAttributes) ? options.keepAttributes : [];

    return {
        privateSelector,
        blockSelector,
        /** Rule 4 alone: (text) => text. */
        words,
        /** rrweb's maskTextFn: (text, element) => text. */
        text: textMasker(words, privateSelector),
        url: (value) => maskUrl(value, rules),
        freeText: (value, max) => scrubFreeText(value, max, rules),
        /** A fresh sanitizer (it remembers nodes: one per rrweb run). */
        sanitizer: () => createSanitizer(words, { privateSelector, keepAttributes, rules }),
    };
}
