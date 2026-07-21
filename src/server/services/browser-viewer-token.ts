/**
 * browser-viewer-token — the shared shape of the per-session viewer
 * credential (KTD-7). Dependency-free so the server proxy (route matching)
 * and the client pane store (iframe src validation) pin the SAME token
 * shape: 24 random bytes base64url-encoded by browser-service
 * mintViewerToken (= 32 chars), carried as the `/s/<token>/` path prefix.
 */

/** Exact length of a minted viewer token (24 bytes -> 32 base64url chars). */
export const VIEWER_TOKEN_LENGTH = 32;

/** Regex source fragment matching exactly one viewer token. */
export const VIEWER_TOKEN_PATTERN = `[A-Za-z0-9_-]{${VIEWER_TOKEN_LENGTH}}`;
