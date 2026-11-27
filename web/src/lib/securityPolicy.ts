export function securityPolicy() {
    // TanStack Start emits page-specific inline hydration scripts.  A static
    // hash cannot allow them, so blocking inline scripts breaks every page
    // after the initial SSR paint. Keep the remaining CSP boundaries while
    // allowing the framework's required scripts.
    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        // Spreadsheet compression uses fflate's generated Blob workers for
        // larger files. Keep this permission specific to worker creation.
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'"
    ].join("; ");
}
