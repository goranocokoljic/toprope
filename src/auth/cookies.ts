export const SESSION_COOKIE = 'gp_session';

/**
 * Parse a Cookie request header into a name→value map. Returns an empty object
 * when the header is absent or malformed. Values are URL-decoded.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) {
        return out;
    }
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) {
            continue;
        }
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) {
            try {
                out[name] = decodeURIComponent(value);
            } catch {
                out[name] = value;
            }
        }
    }
    return out;
}

export interface CookieOptions {
    maxAgeSeconds?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${opts.path ?? '/'}`);
    if (opts.httpOnly !== false) {
        parts.push('HttpOnly');
    }
    parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
    if (opts.secure) {
        parts.push('Secure');
    }
    if (opts.maxAgeSeconds !== undefined) {
        parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
    }
    return parts.join('; ');
}

/** Build a Set-Cookie value that immediately clears the session cookie. */
export function clearCookie(name: string, opts: CookieOptions = {}): string {
    return serializeCookie(name, '', {...opts, maxAgeSeconds: 0});
}
