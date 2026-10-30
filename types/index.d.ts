// Types of @mybeast/sessions. The code is plain ES modules (src/); this file only describes it.

import type { Dictionary } from './mask.js';

export {
    PRIVATE_SELECTORS,
    BLOCK_SELECTORS,
    EXAMPLE_KEY,
    buildUiMasker,
    createMask,
    createTextMask,
    dropIds,
    maskUrl,
    scrubFreeText,
    star,
    uiStrings,
    urlRules,
} from './mask.js';
export type { Dictionary, Mask, MaskOptions, TextMask, UrlRules } from './mask.js';

/** What the host's server hands the page: mybeast/sessions-laravel's Sessions::clientConfig(). */
export interface SessionsConfig {
    url: string;
    key: string;
    env?: string;
    token?: string | null;
}

export interface SessionsClient {
    url: string;
    key: string;
    env: string;
    token: string | null;
    subject: string | null;
    /** The host's yes (rec) and the person's (consent_at). */
    recording: boolean;
    /** Masked unless the token says otherwise in so many words. */
    masked: boolean;
}

/** The client, or null when anything in the config is malformed: the page goes on without it. */
export function init(config: SessionsConfig | null | undefined): SessionsClient | null;

/** A recording needs the host's yes (rec) and the person's (consent_at, unix ms). */
export function mayRecord(claims: Record<string, unknown> | null | undefined): boolean;

/** The claims of a token, or null when it is not a readable JWT. Nothing is verified. */
export function readClaims(token: unknown): Record<string, unknown> | null;
/** Seconds until the token runs out (negative once it has), or null for an unreadable token. */
export function secondsLeft(token: string, nowMs?: number): number | null;

export interface RecorderOptions {
    /** A fresh token, or null once nobody is signed in. */
    getToken?: () => Promise<string | null> | string | null;
    /** A recording pauses after this long without input. */
    idleMinutes?: number;
    /** A recording ends after this long, and the next one starts. */
    maxMinutes?: number;
    /** The words kept readable (rule 4); a function is read once, on first use. */
    dictionary?: Dictionary | (() => Dictionary);
    /** The host's own judge: true keeps a text as it is. */
    readable?: (text: string) => boolean;
    privateSelectors?: string[] | string;
    blockSelectors?: string[] | string;
    keepAttributes?: string[];
    idPatterns?: RegExp[];
    routeWords?: string[] | ((segment: string) => boolean);
    /** The host's name for what is on screen, e.g. 'Invoices/Show'. */
    currentPage?: () => string | null;
    onChange?: (state: RecorderState) => void;
    /** false leaves the page's own requests without the recording's headers. Default true. */
    tagRequests?: boolean;
    window?: Window;
    fetch?: typeof fetch;
    /** rrweb's record(), for tests. */
    record?: (...args: any[]) => any;
}

export type RecorderStatus = 'off' | 'waiting' | 'paused' | 'recording' | 'refused';

export interface CurrentRecording {
    id: string;
    /** Unix ms. */
    startedAt: number;
}

export interface RecorderState {
    status: RecorderStatus;
    recording: CurrentRecording | null;
    /** The last answer to an upload. */
    upload: { status: number; answer: UploadAnswer; doc: number; seq: number; bytes: number } | null;
}

export interface Recorder {
    start(): void;
    stop(): void;
    /** A mark of the host's own: `tag` (32 characters at most), its payload masked like text. */
    mark(tag: string, payload?: Record<string, unknown>): void;
    /** A fresh token (from each response, say): who, whether and how this page is recorded. */
    setToken(token: string | null): void;
    /** The host's page changed without a page load. */
    pageChanged(name: string | null, url?: string): void;
    /** Send what is buffered now (before a deliberate navigation, say). */
    flush(): void;
    /** While recording; @mybeast/errors links an error to its moment with it. */
    currentRecording(): CurrentRecording | null;
    /** The recording's headers for a request the recorder does not tag itself; {} when not recording. */
    requestHeaders(): Record<string, string>;
    state(): RecorderState;
}

/** The recorder of one page load. A null client gives a recorder that does nothing. Call once. */
export function createRecorder(client: SessionsClient | null, options?: RecorderOptions): Recorder;

export type UploadAnswer = 'stored' | 'refresh' | 'stop' | 'drop' | 'rotate' | 'split' | 'retry';

/** What the recorder does with an upload's answer. */
export function answerFor(status: number, refused?: string | null): UploadAnswer;

/** A `refused` mark: the server sent a form back with these errors. */
export function refusedPayload(errors: Record<string, unknown> | null | undefined): { fields: string[]; first?: string };

/** A `visit` mark: a request the page started or finished. */
export function visitPayload(
    phase: 'start' | 'finish',
    visit: { method?: string; url?: string; completed?: boolean; cancelled?: boolean; interrupted?: boolean },
): { phase: 'start' | 'finish'; method: string; url: string; completed?: boolean; cancelled?: boolean; interrupted?: true };
