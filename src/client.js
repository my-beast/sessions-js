// init(): reads what the host's server handed the page (mybeast/sessions-laravel's Sessions::clientConfig()) and
// says whether this page may be recorded. Anything malformed switches the SDK off: init returns null and the page
// goes on as if it were not there - an SDK must never break the page it watches.
//
// The recorder itself (rrweb, chunks, upload) comes next; this is the part every later piece stands on: a page is
// recorded only with a token for this project that says rec, and the moment the person said yes.

import { readClaims } from './token.js';

const PUBLIC_KEY = /^pk_[a-z0-9]{24}$/;
const ENVIRONMENT = /^[a-z0-9_-]{1,32}$/;

/**
 * @param {{url: string, key: string, env?: string, token?: string|null}} config
 * @returns {null | {url: string, key: string, env: string, token: string|null, subject: string|null, recording: boolean, masked: boolean}}
 */
export function init(config) {
    if (!config || typeof config !== 'object') return null;

    let url;
    try {
        url = new URL(config.url);
    } catch {
        return null;
    }

    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.test');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (!PUBLIC_KEY.test(config.key ?? '')) return null;

    // A token for another project is ignored: nothing is recorded for someone the page cannot prove.
    const read = config.token ? readClaims(config.token) : null;
    const claims = read?.iss === config.key ? read : null;

    return {
        url: url.origin + url.pathname.replace(/\/+$/, ''),
        key: config.key,
        env: typeof config.env === 'string' && ENVIRONMENT.test(config.env) ? config.env : 'production',
        token: claims ? config.token : null,
        subject: claims?.sub ?? null,
        recording: mayRecord(claims),
        // Masked unless the token says otherwise in so many words (fail closed).
        masked: claims?.mask !== false,
    };
}

/** A recording needs the host's yes (rec) and the person's (consent_at, unix ms). */
export function mayRecord(claims) {
    return claims?.rec === true && Number.isInteger(claims?.consent_at) && claims.consent_at > 0;
}
