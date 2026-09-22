// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { isRepositoryAutomationAuthor } from "./automation-provenance.js";
import { buildExecutionObligationMarker, isExactWontfixAuthorizationCommand, parseExecutionObligationAuthorization } from "./codex-workflow.js";
import { EXECUTION_OBLIGATION_WRITE_PERMISSIONS, detectSensitiveBodyContent, extractGhErrorMessage, formatFindingClassificationNote, parseOwnerRepoFromRemoteUrl } from "./grc-legacy-compat-2.js";
import { buildPhaseMarker, collectDevStartBlockerFailures, devStartFieldValue, devStartGateFailure, devStartGateSuccess, isConcreteDevStartValue, missingDevStartRequiredFields, readDevStartRiskTotal } from "./grc-legacy-compat.js";
import { DEV_START_GATE_SECURITY_DECISIONS } from "./repo-context.js";
import { fetchPullRequest, parseClosingIssueReferences } from "./github-rest.js";
import { execFile } from "./runtime-primitives.js";

function invalidDevStartSecurityDecision(fields) {
  const securityDecision = devStartFieldValue(fields, "Security relevance decision");
  if (!isConcreteDevStartValue(securityDecision)) return null;
  if (DEV_START_GATE_SECURITY_DECISIONS.includes(securityDecision.trim().toLowerCase())) return null;
  return `Security relevance decision must be one of: ${DEV_START_GATE_SECURITY_DECISIONS.join(", ")}`;
}
export function validateSourceDevStartGate(fields, config) {
  const missing = missingDevStartRequiredFields(fields, config.required_fields);
  const invalid = [];
  const securityError = invalidDevStartSecurityDecision(fields);
  if (securityError) invalid.push(securityError);
  const { riskTotal, invalid: riskError } = readDevStartRiskTotal(fields);
  if (riskError) invalid.push(riskError);
  if (riskTotal != null && riskTotal >= 4) {
    const highRiskEvidence = devStartFieldValue(fields, "High-risk verification evidence");
    if (!isConcreteDevStartValue(highRiskEvidence)) missing.push("High-risk verification evidence");
  }
  const blockerFailures = collectDevStartBlockerFailures(fields, config.blocker_uids);
  missing.push(...blockerFailures.missing);
  invalid.push(...blockerFailures.invalid);

  if (missing.length || invalid.length) {
    return devStartGateFailure({
      planSection: config.plan_section,
      missing,
      invalid,
      sourceBearing: true,
    });
  }
  return devStartGateSuccess({ sourceBearing: true, planSection: config.plan_section, riskTotal });
}
export async function postCodexReviewFindings({
  repoRoot,
  owner,
  name,
  prNumber,
  reviewerLabel,
  findings,
}) {
  if (prNumber == null || !Array.isArray(findings) || findings.length === 0) {
    return [];
  }
  // Resolve the PR head SHA from GitHub (canonical), not from `git rev-parse
  // HEAD`. The local working tree could be ahead of the pushed PR head if
  // the agent has uncommitted changes — anchoring comments to a SHA that
  // GitHub doesn't have on the PR will return 422.
  //
  // If the head-SHA fetch itself fails (network, gh auth, repo perms), we
  // mark every finding as a per-finding failure rather than throwing. This
  // preserves the runCodexReview contract that findings are never silently
  // dropped — the post_failures envelope carries the structured error so
  // the agent can address the underlying infrastructure issue (closes a gap
  // flagged in #793 review cycle 3).
  let headSha;
  try {
    headSha = await getPullRequestHeadSha(repoRoot, owner, name, prNumber);
  } catch (error) {
    const headFailureMsg = `headRefOid fetch failed: ${extractGhErrorMessage(error)}`;
    return findings.map((finding) => ({ ok: false, finding, error: headFailureMsg }));
  }

  const results = [];
  for (const finding of findings) {
    // Non-LLM content filter on the body before publishing. The body is
    // model-controlled output; a malicious diff can use prompt injection to
    // coerce codex into emitting workspace contents (private keys, AWS
    // access keys, etc.). The prompt instruction not to include secrets is
    // not a security boundary — this is the host-side check the security
    // reviewer asked for in #793 cycle 4. Necessarily incomplete (cat-and-
    // mouse with the attacker), but it catches the obvious well-known
    // markers before they get published under the host identity.
    const sensitiveError = detectSensitiveBodyContent(renderInlineReviewCommentBody(reviewerLabel, finding));
    if (sensitiveError) {
      results.push({ ok: false, finding, error: sensitiveError });
      continue;
    }
    try {
      const apiResponse = await postSingleReviewComment({
        repoRoot,
        owner,
        name,
        prNumber,
        headSha,
        reviewerLabel,
        finding,
      });
      // A response with no numeric `id` is a broken POST shape — the comment
      // didn't actually land in a way the verify-finding loop can address.
      // Treat it as a per-finding failure so it appears in post_failures and
      // cannot masquerade as a successful write (closes a gap flagged in
      // #793 review cycle 1).
      if (!Number.isInteger(apiResponse?.id)) {
        results.push({
          ok: false,
          finding,
          error: `gh POST returned no numeric .id (got ${JSON.stringify(apiResponse)})`,
        });
        continue;
      }
      results.push({
        ok: true,
        finding,
        comment_id: apiResponse.id,
        html_url: typeof apiResponse?.html_url === "string" ? apiResponse.html_url : null,
      });
    } catch (error) {
      results.push({ ok: false, finding, error: extractGhErrorMessage(error) });
    }
  }
  return results;
}
async function getPullRequestHeadSha(repoRoot, owner, name, prNumber) {
  // REST pull-request read; `gh pr view` spends the shared GraphQL budget (issue #1584).
  const pr = await fetchPullRequest(repoRoot, owner, name, prNumber);
  if (typeof pr?.headRefOid !== "string" || pr.headRefOid.trim() === "") {
    throw new Error(`GitHub REST pull request #${prNumber} returned no head sha`);
  }
  return pr.headRefOid;
}
/**
 * Render the exact comment body that will be published.
 *
 * Shared with the sensitive-content filter so the filter inspects the string that is actually sent.
 * It used to inspect `finding.body` alone while the posted body also spliced in `finding.title` and
 * the classification note, both equally model-controlled: a key in the title passed the guardrail
 * and was published under the host identity. Checking a component of what you send is not checking
 * what you send.
 */
function renderInlineReviewCommentBody(reviewerLabel, finding) {
  return `[${reviewerLabel}] ${finding.title}\n\n${formatFindingClassificationNote(finding)}${finding.body}`;
}
async function postSingleReviewComment({
  repoRoot,
  owner,
  name,
  prNumber,
  headSha,
  reviewerLabel,
  finding,
}) {
  const body = renderInlineReviewCommentBody(reviewerLabel, finding);
  // GitHub's REST shape for inline review comments. `commit_id` anchors the
  // comment to the PR's current head SHA. `side: RIGHT` anchors to the new
  // (post-change) side of the diff. `line` is always a positive integer here
  // — file-level comments are not yet supported (the validator rejects
  // line: null upstream so this code path stays simple).
  const args = [
    "api",
    "--method",
    "POST",
    `/repos/${owner}/${name}/pulls/${prNumber}/comments`,
    "-f",
    `commit_id=${headSha}`,
    "-f",
    `path=${finding.path}`,
    "-f",
    `side=RIGHT`,
    "-F",
    `line=${finding.line}`,
    "-f",
    `body=${body}`,
  ];
  const { stdout } = await execFile("gh", args, { cwd: repoRoot });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const detail = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
    // A collaborator lookup can definitively report that an author has no
    // repository relationship. Transport and authorization failures remain
    // unresolved so security decisions can fail closed.
    return /\b404\b/.test(detail) ? null : undefined;
  }
}
/**
 * Resolve the GitHub owner/repo for a checkout.
 *
 * The git-remote path is authoritative because git ignores `GH_REPO`. The `gh repo view` fallback
 * honours it and is therefore an env-hijack seam, so it is opt-in rather than the default: every
 * caller that reads or writes under the host identity gets the fail-closed behaviour without having
 * to remember to ask for it. The previous default was the other way round, and reviewing which of
 * the twenty-odd call sites had remembered is exactly the audit a safe default removes. A caller
 * that is genuinely repo-agnostic passes `allowGhFallback: true` deliberately.
 */
export async function getOwnerRepo(repoRoot, { allowGhFallback = false } = {}) {
  // Primary path: read the git remote URL directly. git ignores GH_REPO,
  // so this path is immune to env-var hijack and is the source of truth
  // for every real /implement run (real repos always have an origin
  // remote — that's where they were cloned from).
  try {
    const { stdout } = await execFile(
      "git",
      ["-C", repoRoot, "remote", "get-url", "origin"],
    );
    const parsed = parseOwnerRepoFromRemoteUrl(stdout);
    if (parsed !== null) return parsed;
    // origin exists but isn't a github.com URL — fall through to the
    // gh fallback rather than throwing immediately. A non-github origin
    // is unusual but the gh CLI might still resolve via its own config.
  } catch {
    // No origin remote (typical only in test fixtures that init a bare
    // repo without setting origin, or in an emergency detached state).
    // Fall through.
  }
  if (!allowGhFallback) {
    // Mutating / identity-sensitive callers (issue creation, issue-context
    // reads) pass allowGhFallback:false so a failed git-remote derivation
    // fails closed instead of falling through to the GH_REPO-honoring
    // `gh repo view` path — that fallback is the env-hijack class (GC-P026,
    // issue #934 lineage) and must never route a repo-bound operation at an
    // attacker- or misconfiguration-supplied repository.
    throw new Error(
      "Unable to resolve a GitHub owner/repo from the checkout's git 'origin' remote; " +
        "refusing to fall back to GH_REPO-sensitive resolution.",
    );
  }
  // Fallback: `gh repo view --json nameWithOwner`. This path honors GH_REPO and is therefore
  // vulnerable to env hijack. It is now reached only when a caller opted in explicitly, and only
  // when the git-remote path already failed. Real repos always have a github.com origin, so it is
  // exercised by tests and pathological states. Documented in the issue #934 follow-up.
  // `gh api` resolves `{owner}/{repo}` the same way `gh repo view` does, over REST (issue #1584).
  const { stdout } = await execFile(
    "gh",
    ["api", "repos/{owner}/{repo}", "--jq", ".full_name"],
    { cwd: repoRoot },
  );
  const [owner, name] = String(stdout).trim().split("/");
  if (!owner || !name) {
    throw new Error(`Unable to parse owner/repo from the GitHub REST repository read: ${stdout}`);
  }
  return { owner, name };
}
export async function getPullRequestClosingIssues(repoRoot, prNumber) {
  // The repository comes from the git remote (GH_REPO cannot retarget it), and the PR body is read
  // over REST: GitHub closing keywords in the body are the closing references. `gh pr view --json
  // closingIssuesReferences` spent the shared GraphQL budget (issue #1584).
  try {
    const { owner, name } = await getOwnerRepo(repoRoot);
    const pr = await fetchPullRequest(repoRoot, owner, name, prNumber);
    return parseClosingIssueReferences(pr?.body, owner, name);
  } catch {
    return [];
  }
}
export async function readIssueCommentBodies(repoRoot, owner, name, issueNumber) {
  const { stdout } = await execFile(
    "gh",
    [
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
      "-F",
      "per_page=100",
    ],
    { cwd: repoRoot },
  );
  const pages = JSON.parse(stdout);
  if (!Array.isArray(pages)) return [];
  // `--slurp` produces array-of-arrays (one inner array per page). Flatten
  // before extracting body strings. Tolerate the legacy single-array shape
  // as well, in case future gh versions change this behavior.
  const comments = pages.length > 0 && Array.isArray(pages[0]) ? pages.flat() : pages;
  return comments
    .map((c) => (c && typeof c.body === "string" ? c.body : null))
    .filter((b) => b != null);
}
export async function readIssueCommentsWithAuthors(repoRoot, owner, name, issueNumber) {
  const { stdout } = await execFile(
    "gh",
    [
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
      "-F",
      "per_page=100",
    ],
    { cwd: repoRoot },
  );
  const pages = JSON.parse(stdout);
  if (!Array.isArray(pages)) return [];
  const comments = pages.length > 0 && Array.isArray(pages[0]) ? pages.flat() : pages;
  return comments
    .filter((c) => c && typeof c.body === "string")
    .map((c) => ({
      id: Number.isInteger(c.id) ? c.id : null,
      body: c.body,
      authorLogin: c.user && typeof c.user.login === "string" ? c.user.login : null,
      authorAssociation:
        typeof c.author_association === "string" ? c.author_association.toUpperCase() : null,
      // `Bot` distinguishes a GitHub App identity from a user with the same-looking login,
      // which is what the repository-automation trust class keys on (issue #1671).
      authorType: c.user && typeof c.user.type === "string" ? c.user.type : null,
      // When the comment was posted, so an authorization can be bound to the review
      // run it answers rather than to any run it happens to name (issue #1679).
      createdAt: typeof c.created_at === "string" ? c.created_at : null,
    }));
}
export async function getAuthenticatedGitHubLogin(repoRoot) {
  try {
    const { stdout } = await execFile("gh", ["api", "user", "--jq", ".login"], { cwd: repoRoot });
    const login = typeof stdout === "string" ? stdout.trim() : "";
    return login !== "" ? login : null;
  } catch {
    return null;
  }
}
async function getEffectiveRepositoryPermission(repoRoot, owner, name, login) {
  if (typeof login !== "string" || login.trim() === "") return null;
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`,
        "--jq",
        ".permission",
      ],
      { cwd: repoRoot },
    );
    const permission = stdout.trim().toLowerCase();
    return EXECUTION_OBLIGATION_WRITE_PERMISSIONS.has(permission) ? permission : null;
  } catch {
    return null;
  }
}
export async function resolveExecutionObligationTrust(repoRoot, owner, name, comments) {
  const logins = [...new Set(
    comments
      .map((comment) => comment.authorLogin?.toLowerCase() ?? null)
      .filter(Boolean),
  )];
  const permissions = new Map();
  await Promise.all(logins.map(async (login) => {
    permissions.set(
      login,
      await getEffectiveRepositoryPermission(repoRoot, owner, name, login),
    );
  }));
  return {
    isTrusted: (comment) => {
      const login = comment.authorLogin?.toLowerCase() ?? null;
      return login != null && permissions.get(login) != null;
    },
    isResolved: (comment) => {
      const login = comment.authorLogin?.toLowerCase() ?? null;
      return login != null && permissions.get(login) !== undefined;
    },
    // A SECOND, distinct class (issue #1671). The repository's own Actions identity is a
    // GitHub App, so the collaborator endpoint reports no permission for it and `isTrusted`
    // is correctly false. Only the final-report marker gate consults this class, and only
    // together with verified run provenance; `wontfix` authorization and the merged-state
    // override still require a repo-write human.
    isRepositoryAutomation: (comment) => isRepositoryAutomationAuthor(comment),
  };
}
export function hasVerifiedStructuredWontfixAuthorization(
  authorization,
  comments,
  trust,
  issueNumber,
  obligationId,
) {
  if (authorization == null || !trust.isTrusted(authorization)) return false;
  const record = parseExecutionObligationAuthorization(
    authorization.body,
    issueNumber,
    obligationId,
  );
  if (record == null) return false;
  const source = comments.find((comment) => comment.id === record.sourceCommentId);
  return source != null
    && trust.isTrusted(source)
    && isExactWontfixAuthorizationCommand(source.body, obligationId);
}
export async function postPhaseMarker(repoRoot, owner, name, issueNumber, phase, extras = {}) {
  const marker = buildPhaseMarker({ phase, issueNumber });
  const body = extras.commentBody ? `${marker}\n\n${extras.commentBody}` : marker;
  const { stdout } = await execFile(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `/repos/${owner}/${name}/issues/${issueNumber}/comments`,
      "-f",
      `body=${body}`,
    ],
    { cwd: repoRoot },
  );
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
export function buildExecutionObligationBody(input) {
  const marker = buildExecutionObligationMarker(input);
  const eventLabel = input.event === "opened"
    ? "Opened"
    : input.event === "escalated"
      ? "Escalated"
      : "Resolved";
  const lines = [
    marker,
    "",
    `## Execution obligation ${input.obligationId} — ${eventLabel}`,
    "",
    `**Category:** ${input.category}  `,
    `**Observed state:** ${input.observedState}  `,
    `**Impact:** ${input.impact}  `,
    `**Current obligation:** ${input.obligation}`,
    "",
    "### Evidence",
    "",
    ...input.evidence.map((item) => `- ${item}`),
  ];
  if (input.event === "escalated") {
    lines.push(
      "",
      `**Pause class:** ${input.pauseClass}  `,
      `**Decision request:** ${input.decisionRequest}`,
      "",
      "This obligation remains open while the decision is pending.",
    );
  }
  if (input.event === "resolved") {
    lines.push(
      "",
      `**Disposition:** ${input.disposition}  `,
      `**Corrective action:** ${input.correctiveAction}`,
      "",
      "### Verification",
      "",
      ...input.verification.map((item) => `- ${item}`),
    );
    if (input.userAuthorization) {
      lines.push("", `**User authorization:** ${input.userAuthorization}`);
    }
  }
  return lines.join("\n");
}
