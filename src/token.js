// Client tokens (schemas/v1/client-token.schema.json): the host's server signs them; the browser only carries them
// and reads two things - who it is for, and when it runs out - to ask the host for a fresh one in time (the
// recorder's getToken hook). Nothing here verifies a signature: the browser never holds the key, the service checks.

/** The claims of a token, or null when it is not a readable JWT. */
export function readClaims(token) {
    if (typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    try {
        const claims = JSON.parse(base64UrlDecode(parts[1]));
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
    } catch {
        return null;
    }
}

/** Seconds until the token runs out (negative once it has), or null for an unreadable token. */
export function secondsLeft(token, nowMs = Date.now()) {
    const exp = readClaims(token)?.exp;
    return Number.isInteger(exp) ? exp - Math.floor(nowMs / 1000) : null;
}

function base64UrlDecode(segment) {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}
