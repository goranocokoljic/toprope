/**
 * Returns true if `url` is `prefix` exactly, a child path (`prefix/...`), or
 * `prefix` followed by a query string. Shared by the auth middleware and the
 * dashboard static handler so the path-prefix predicate has one definition.
 */
export function matchesPathPrefix(url: string, prefix: string): boolean {
    return url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);
}
