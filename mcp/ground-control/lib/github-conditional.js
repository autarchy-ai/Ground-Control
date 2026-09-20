// Conditional GitHub reads for the remote-gate watchers (issue #1671).
//
// Watching a pull request means asking the same few endpoints the same question until the
// answer changes. Unconditionally, that is roughly five REST calls every fifteen seconds
// for up to forty-five minutes per monitored head — several hundred requests against a
// 5,000/hour token that every agent and tool on the host shares, almost all of them
// spent learning that nothing happened. Exhausting it fails unrelated work outright.
//
// A conditional request carries the previous response's `ETag` in `If-None-Match`. When
// nothing changed GitHub answers `304 Not Modified` with no body, and — this is the point —
// a 304 does not count against the primary rate limit. Measured on this repository, ten
// conditional requests cost ~0 of the quota that ten unconditional ones cost ten of.
//
// `gh api --include` prints the status line and headers before the body and exits 0 on a
// 304, so the existing argv-based `gh` boundary (ADR-027) still owns the call; nothing here
// opens its own HTTP client or handles a credential.

import { execFile as defaultExecFile } from "./runtime-primitives.js";

// Per-endpoint last-seen ETag and parsed body. Bounded because a long-lived server watches
// many heads over its lifetime and this must not become a leak.
const ETAG_CACHE_MAX = 256;
const _etagCache = new Map();

const STATUS_LINE_RE = /^HTTP\/[\d.]+\s+(\d{3})/i;

/**
 * Split `gh api --include` output into its final response's headers and body.
 *
 * A redirect emits more than one header block, so the LAST status line wins: that is the
 * response whose ETag and body the caller is actually being given.
 */
export function parseIncludedResponse(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const normalized = text.replace(/\r\n/g, "\n");
  let searchFrom = 0;
  let lastStart = -1;
  for (;;) {
    const index = normalized.indexOf("HTTP/", searchFrom);
    if (index === -1) break;
    const atLineStart = index === 0 || normalized[index - 1] === "\n";
    if (atLineStart && STATUS_LINE_RE.test(normalized.slice(index, index + 40))) lastStart = index;
    searchFrom = index + 5;
  }
  if (lastStart === -1) return { status: null, headers: {}, body: "" };
  const block = normalized.slice(lastStart);
  const separator = block.indexOf("\n\n");
  const headerText = separator === -1 ? block : block.slice(0, separator);
  const body = separator === -1 ? "" : block.slice(separator + 2);
  const lines = headerText.split("\n");
  const status = Number.parseInt(STATUS_LINE_RE.exec(lines[0])?.[1] ?? "", 10);
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number.isInteger(status) ? status : null, headers, body };
}

function remember(cache, key, entry) {
  // Oldest-first eviction; Map preserves insertion order.
  if (!cache.has(key) && cache.size >= ETAG_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/**
 * GET one endpoint, reusing the previous response when GitHub says it is unchanged.
 *
 * @returns `{changed, body, status, paginated}`. `changed: false` means the server answered
 *   304 and `body` is the previously parsed response. `paginated: true` means the response
 *   declared a next page, so a caller that needs every page must not treat one unchanged
 *   first page as the whole answer.
 */
export async function ghConditionalGet(repoRoot, path, {
  execFile = defaultExecFile,
  cache = _etagCache,
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  const key = `${repoRoot}\u0000${path}`;
  const cached = cache.get(key);
  const args = ["api", path, "--include"];
  if (cached?.etag) args.push("-H", `If-None-Match: ${cached.etag}`);
  const { stdout } = await execFile("gh", args, { cwd: repoRoot, maxBuffer });
  const { status, headers, body } = parseIncludedResponse(stdout);

  if (status === 304 && cached) {
    return { changed: false, body: cached.body, status, paginated: cached.paginated };
  }
  let parsed = null;
  if (body.trim() !== "") {
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`GitHub response for ${path} was not JSON: ${error.message}`);
    }
  }
  const paginated = /(^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(headers.link ?? "");
  // Only a response that carries an ETag can be revalidated later; caching one without it
  // would make the next request unconditional anyway.
  if (typeof headers.etag === "string" && headers.etag !== "") {
    remember(cache, key, { etag: headers.etag, body: parsed, paginated });
  }
  return { changed: true, body: parsed, status, paginated };
}

/** Drop every remembered ETag. Tests use it; production never needs to. */
export function clearConditionalCache(cache = _etagCache) {
  cache.clear();
}
