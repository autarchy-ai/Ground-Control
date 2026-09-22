// Issue-thread projection of release-identity events (issue #1579, ADR-097, ADR-029).
//
// The reference log is the authority; this is the durable workflow record. Bodies are composed
// only from values the ledger validated, so no caller text reaches the thread. Each event's record
// carries its event commit in the marker, and a retry posts only the records this server's own
// GitHub identity has not already posted. GitHub offers no conditional comment create, so the
// projection is at-least-once: a lost POST response can duplicate a record, never an event.

import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { invalidateIssueThreadCacheEntry } from "./issue-thread.js";
import { GITHUB_ISSUE_COMMENT_BODY_MAX } from "./repo-vocabulary.js";
import { implementPickupRecordedBy } from "./run-lane-evidence.js";

/** Whether this server's GitHub identity recorded `/implement` ownership of the issue branch. */
export async function isTrustedImplementRunBranch(api, issueNumber, branch) {
  const login = await api.authenticatedLogin();
  if (login == null) return false;
  const comments = await api.listIssueComments(issueNumber);
  // This API shape spells the author as `user.login`; the lane reader's shape
  // spells it `authorLogin`. One parser, two callers (issue #1679).
  return implementPickupRecordedBy(
    comments.map((comment) => ({ body: comment?.body, authorLogin: comment?.user?.login ?? null })),
    login,
    branch,
  );
}

export function releaseIdentityRecordMarker({ family, slot, sequence, event, commit }) {
  return `<!-- gc:release-identity family="${family}" slot="${slot}" sequence="${sequence}" event="${event}" commit="${commit}" -->`;
}

const row = (label, value) => `| ${label} | ${value} |`;

function renderRecord(view, event, commit) {
  const lines = [
    releaseIdentityRecordMarker({ family: view.family, slot: view.slot, sequence: view.sequence, event, commit }),
    "",
    `## Release identity — \`${view.family}\` #${view.sequence} — ${event}`,
    "",
    "| Field | Value |",
    "|---|---|",
    row("Repository", `\`${view.repository}\``),
    row("Version", `\`${view.version}\``),
    row("Base", `\`${view.base_branch}\` @ \`${view.base_revision}\``),
    row("Idempotency hash", `\`${view.idempotency_hash}\``),
    ...Object.entries(view.paths).map(([key, path]) => row(`Path \`${key}\``, `\`${path}\``)),
    row("Event", `\`${event === "reserved" ? view.claim_ref : view.outcome_ref}\` → \`${commit}\``),
  ];
  if (event === "published") {
    lines.push(row("Published at", `\`${view.base_branch}\` @ \`${view.published_revision}\``));
    for (const [key, blob] of Object.entries(view.artifacts)) lines.push(row(`Artifact \`${key}\``, `blob \`${blob}\``));
  }
  if (event === "abandoned") lines.push(row("Reason", `\`${view.reason}\``));
  lines.push("", "Recorded by the MCP server from the repository reservation log. The identity is never reissued.");
  return `${lines.join("\n")}\n`;
}

function eventsOf(view) {
  const events = [{ event: "reserved", commit: view.claim_commit }];
  if (view.outcome_commit) events.push({ event: view.state, commit: view.outcome_commit });
  return events;
}

/**
 * Post every record of `view`'s events that this server has not already posted.
 * Returns `{ ok: true, urls, posted }` or `{ ok: false, pending, message }` with a fixed message.
 */
export async function ensureReleaseIdentityRecords(api, repoRoot, view) {
  const wanted = eventsOf(view).map(({ event, commit }) => ({
    event,
    marker: releaseIdentityRecordMarker({ family: view.family, slot: view.slot, sequence: view.sequence, event, commit }),
    body: renderRecord(view, event, commit),
  }));
  if (wanted.some(({ body }) => detectSensitiveBodyContent(body) || Buffer.byteLength(body, "utf8") > GITHUB_ISSUE_COMMENT_BODY_MAX)) {
    return { ok: false, pending: wanted.map((w) => w.event), message: "the issue record failed the public-text guardrails" };
  }
  let comments;
  let login;
  try {
    login = await api.authenticatedLogin();
    comments = login == null ? null : await api.listIssueComments(view.issue_number);
  } catch {
    comments = null;
  }
  if (comments == null) {
    return { ok: false, pending: wanted.map((w) => w.event), message: "the server's GitHub identity or the issue's records could not be read" };
  }
  const own = comments.filter((c) => typeof c?.body === "string" && c.user?.login?.toLowerCase() === login.toLowerCase());
  const urls = {};
  const pending = [];
  let posted = 0;
  for (const { event, marker, body } of wanted) {
    const existing = own.find((c) => c.body.startsWith(marker));
    if (existing) {
      urls[event] = existing.html_url ?? null;
      continue;
    }
    try {
      urls[event] = await api.postIssueComment(view.issue_number, body);
      posted += 1;
    } catch {
      pending.push(event);
    } finally {
      invalidateIssueThreadCacheEntry(repoRoot, view.issue_number);
    }
  }
  if (pending.length > 0) return { ok: false, pending, message: "the issue record could not be posted" };
  return { ok: true, urls, posted };
}
