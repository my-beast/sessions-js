// Types of @mybeast/sessions/mask: the masking alone, without rrweb. The code is src/mask.js.

/** Text that may be a dictionary: strings, nested objects of them (i18next resources), or an array of either. */
export type Dictionary = string[] | Record<string, unknown> | Array<string | Record<string, unknown>>;

/** (text) => text. */
export type TextMask = (text: string) => string;

/** Rule 3: inside these every word is masked. */
export const PRIVATE_SELECTORS: readonly string[];
export const PRIVATE_SELECTOR: string;
/** Rule 2: blocked (media, frames, graphics), whatever the mode. */
export const BLOCK_SELECTORS: readonly string[];
export const BLOCK_SELECTOR: string;
/** Keys whose values are made-up people: a real person may share them, never kept. */
export const EXAMPLE_KEY: RegExp;

/** Every non-space character as a star: the layout keeps its shape, the words go. */
export function star(value: unknown): string;

/** Every string of a host's dictionaries, without made-up examples and what `skip` matches. */
export function uiStrings(source: Dictionary, options?: { skip?: RegExp | null; examples?: RegExp }): string[];

/** (text) => text with only the dictionary's words readable. */
export function buildUiMasker(strings: string[]): TextMask;

/** Rule 4: `readable` decides first, else the dictionary (read once, on first use). Neither: every word masked. */
export function createTextMask(options?: {
    dictionary?: Dictionary | (() => Dictionary) | null;
    readable?: ((text: string) => boolean) | null;
}): TextMask;

/** rrweb's maskTextFn: rule 3 on the live page, rule 4 elsewhere. */
export function textMasker(ui: TextMask, privateSelector?: string): (text: string, element: Element | null) => string;

/** What counts as an id, and which path segments stay. Built once; the url helpers take it last. */
export interface UrlRules {
    anywhere: RegExp[];
    whole: RegExp[];
    keep: (segment: string) => boolean;
}

export function urlRules(options?: { idPatterns?: RegExp[]; routeWords?: string[] | ((segment: string) => boolean) | null }): UrlRules;

/** Ids out of a text that is otherwise kept (an id, a class, a style). */
export function dropIds(value: unknown, rules?: UrlRules): string;
/** A URL as a recording may hold it: route words only, ids as `:id`, no query or hash. */
export function maskUrl(value: unknown, rules?: UrlRules): string;
/** url(...) inside a style through maskUrl, and ids out of the rest. */
export function maskCssUrls(style: unknown, rules?: UrlRules): string;
/** Free text kept readable for debugging, with e-mail addresses, ids, IBANs and long digit runs masked. */
export function scrubFreeText(value: unknown, max?: number, rules?: UrlRules): string;

/** A selector list split at its top-level commas. */
export function splitSelectors(selector: string): string[];
/** (tagName, attributes) => true when a serialized node matches one of the selectors (simple selectors only). */
export function nodeMatcher(selector: string): (tagName: string, attributes: Record<string, unknown>) => boolean;

/** The masked recording's sanitizer: (rrweb event) => the event cleaned in place, or null when it must not leave. */
export function createSanitizer(
    ui: TextMask,
    options?: { privateSelector?: string; keepAttributes?: string[]; rules?: UrlRules },
): (event: any) => any | null;

export interface MaskOptions {
    dictionary?: Dictionary | (() => Dictionary) | null;
    readable?: ((text: string) => boolean) | null;
    /** Added to PRIVATE_SELECTORS. */
    privateSelectors?: string[] | string;
    /** Added to BLOCK_SELECTORS. */
    blockSelectors?: string[] | string;
    keepAttributes?: string[];
    idPatterns?: RegExp[];
    routeWords?: string[] | ((segment: string) => boolean) | null;
    /** The browser's own check: a block selector it cannot read is left out. */
    validSelector?: (selector: string) => boolean;
}

export interface Mask {
    privateSelector: string;
    blockSelector: string;
    /** Rule 4 alone. */
    words: TextMask;
    /** rrweb's maskTextFn. */
    text: (text: string, element: Element | null) => string;
    url: (value: unknown) => string;
    freeText: (value: unknown, max?: number) => string;
    /** A fresh sanitizer (it remembers nodes: one per rrweb run). */
    sanitizer: () => (event: any) => any | null;
}

/** Everything the recorder masks with, from its options. */
export function createMask(options?: MaskOptions): Mask;
