// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { requestedRequirementUidAuthorization } from "./codex-workflow-2.js";
import { extractInScopeRequirementUids } from "./issue-requirements-scope.js";
import { summarizeTraceabilityLinks } from "./codex-workflow.js";
import { getOwnerRepo } from "./grc-legacy-compat-3.js";
import { buildVocabularySection } from "./grc-legacy-compat-5.js";
import { runGetIssueThread } from "./issue-thread.js";
import { GITHUB_REPO_RE, execFile } from "./runtime-primitives.js";

export function pick(args, keys) {
  const out = {};
  for (const k of keys) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  return out;
}
export function reqArg(args, key, action) {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`'${key}' is required for action='${action}'`);
  }
  return v;
}
export function formatIssueBody(req, extraBody) {
  const headerParts = [
    `**${req.uid}**`,
    req.requirement_type || "FUNCTIONAL",
    req.priority || "SHOULD",
  ];
  if (req.wave != null) {
    headerParts.push(`Wave ${req.wave}`);
  }
  headerParts.push(req.status || "DRAFT");

  // The `## Requirements` section is the authoritative list of requirement
  // UIDs in scope for the issue — the `/implement` workflow parses it as
  // `in_scope_requirements[]` and drives clause verification, traceability
  // reconciliation, and DRAFT→ACTIVE transitions from that list. Any issue
  // created from a Ground Control requirement must seed this section so the
  // round-trip "create issue from requirement → /implement → reconcile"
  // works without a manual body edit.
  //
  // The requirement title arrives as `folder_title`: request() runs every
  // response through toSnakeCase, which renames `title` → `folder_title`
  // globally (the mapping exists for test-case folders but is not namespaced).
  // Fall back to `title` for direct/hand-constructed callers.
  //
  // The title is untrusted input — it can contain newlines, leading `- `
  // sequences, or markdown that would produce extra bullets and trick the
  // parser into picking up an unrelated UID. Collapse all whitespace runs
  // to a single space so the bullet is guaranteed to be a single line.
  const titleValue = req.folder_title ?? req.title;
  const sanitizedTitle = titleValue
    ? titleValue.replace(/\s+/g, " ").trim()
    : null;
  const requirementsLine = sanitizedTitle
    ? `- ${req.uid} — ${sanitizedTitle}`
    : `- ${req.uid}`;
  let body =
    `> ${headerParts.join(" | ")}` +
    `\n\n## Requirements\n\n${requirementsLine}` +
    `\n\n## Statement\n\n${req.statement}`;

  if (req.rationale) {
    body += `\n\n## Rationale\n\n${req.rationale}`;
  }

  body += `\n\n---\n*Created from Ground Control requirement ${req.uid}*`;

  if (extraBody) {
    body += `\n\n${extraBody}`;
  }

  return body;
}
export async function createGitHubIssue({ title, body, labels, repo, repoRoot }) {
  // Issue creation is a mutation. Derive identity from the checkout's git
  // remote and fail closed (allowGhFallback:false) rather than honor GH_REPO
  // or `gh repo view` — routing a *write* at a GH_REPO-supplied repo is the
  // exact hijack GC-P026 closes. A caller-supplied `repo` is a validated
  // assertion that must agree (case-insensitively) with the checkout, never an
  // alternate destination.
  let slug;
  try {
    const { owner, name } = await getOwnerRepo(repoRoot, { allowGhFallback: false });
    slug = `${owner}/${name}`;
  } catch (error) {
    throw new Error(`createGitHubIssue: cannot resolve the checkout's GitHub repository; refusing to create an issue: ${error.message}`);
  }
  if (repo) {
    if (!GITHUB_REPO_RE.test(repo)) {
      throw new Error(`Invalid GitHub repo format: expected 'owner/repo', got '${repo}'`);
    }
    if (repo.toLowerCase() !== slug.toLowerCase()) {
      throw new Error(`Supplied repo '${repo}' does not match the checkout's origin remote '${slug}'; refusing to create the issue at a mismatched repository.`);
    }
  }
  // REST issue creation; `gh issue create` spent the shared GraphQL budget (issue #1584).
  const args = ["api", "--method", "POST", `/repos/${slug}/issues`, "-f", `title=${title}`, "-f", `body=${body}`];
  for (const label of labels ?? []) args.push("-f", `labels[]=${label}`);

  const { stdout } = await execFile("gh", args);
  const created = JSON.parse(stdout);
  if (!Number.isInteger(created?.number) || typeof created?.html_url !== "string") {
    throw new Error(`GitHub REST issue creation returned no issue number: ${stdout.slice(0, 200)}`);
  }
  return { url: created.html_url, number: created.number };
}
export async function authorizeRequestedRequirementUid(
  { repoPath, issueNumber, requestedRequirementUid },
  { issueThreadReader = runGetIssueThread } = {},
) {
  const explicit = requestedRequirementUid != null && requestedRequirementUid !== "";
  if (!explicit && issueNumber == null) {
    return { ok: true, requirementUid: null };
  }
  const thread = await issueThreadReader({ repoPath, issueNumber });
  if (!thread?.ok) {
    if (!explicit) {
      // Auto-resolution is best-effort gate context, not a caller assertion, so
      // an unreadable issue keeps the prior no-UID behaviour instead of blocking.
      return { ok: true, requirementUid: null };
    }
    return {
      ok: false,
      error: thread?.error ?? "implement_requested_requirement_uid_unverifiable",
      message: thread?.message
        ?? "The target issue could not be read to authorize the requested requirement UID",
      next_action: "repair_issue_access_and_retry",
    };
  }
  if (explicit) {
    return requestedRequirementUidAuthorization(thread.body, requestedRequirementUid);
  }
  // No explicit UID: carry the issue's sole in-scope requirement into the
  // repository gates so a branch that names the issue number instead of the
  // requirement UID still gives the governance gate its context. This completes
  // the #1434 expectation that the UID reach "any mechanical phase that runs
  // repository gates" (verify, publish, and base-sync completion) — those paths
  // already export it, but only when a value reaches them, and the caller does
  // not always have one to pass. Zero (requirement-free) or multiple (ambiguous)
  // in-scope requirements resolve to no UID, unchanged.
  const inScope = extractInScopeRequirementUids(thread.body);
  return { ok: true, requirementUid: inScope.length === 1 ? inScope[0] : null };
}
export async function getIssueContext(issueNumber, repo, { cwd } = {}) {
  if (issueNumber == null) return null;

  // Repo-bound reads derive identity from the checkout's git remote (GC-P026)
  // and never consult process.env.GH_REPO: git ignores GH_REPO, so this path
  // is immune to the env-hijack class. A caller-supplied `repo` is a validated
  // assertion, not an alternate destination — it must agree (case-insensitively)
  // with the checkout. allowGhFallback:false keeps a failed derivation from
  // sliding into the GH_REPO-honoring `gh repo view` path.
  if (!cwd) {
    return {
      number: issueNumber,
      warning: "Failed to resolve repository identity for issue context: no checkout path (cwd) supplied",
    };
  }
  let slug;
  try {
    const { owner, name } = await getOwnerRepo(cwd, { allowGhFallback: false });
    slug = `${owner}/${name}`;
  } catch (error) {
    return {
      number: issueNumber,
      warning: `Failed to resolve repository identity for issue context: ${error.message}`,
    };
  }
  if (repo) {
    if (!GITHUB_REPO_RE.test(repo)) {
      return {
        number: issueNumber,
        warning: `Invalid GitHub repo format: expected 'owner/repo', got '${repo}'`,
      };
    }
    if (repo.toLowerCase() !== slug.toLowerCase()) {
      return {
        number: issueNumber,
        warning: `Supplied repo '${repo}' does not match the checkout's origin remote '${slug}'`,
      };
    }
  }

  // REST issue read; `gh issue view` spent the shared GraphQL budget (issue #1584).
  const args = ["api", `/repos/${slug}/issues/${issueNumber}`];

  try {
    const { stdout } = await execFile("gh", args, { cwd });
    const issue = JSON.parse(stdout);
    return { number: issue.number, title: issue.title, body: issue.body ?? "" };
  } catch (error) {
    return {
      number: issueNumber,
      warning: `Failed to fetch GitHub issue context: ${error.message}`,
    };
  }
}

export function buildCodexArchitecturePreflightPrompt({ requirement = null, traceabilityLinks = [], issueContext = null, vocabulary = null }) {
  const hasRequirement = requirement != null;
  const traceabilitySummary = hasRequirement ? summarizeTraceabilityLinks(traceabilityLinks) : [];

  const lines = [
    "You are Codex performing an architecture preflight before implementation.",
    "",
    "Your job is to set the implementation on the right road before coding starts.",
    "",
    "Hard constraints:",
    hasRequirement
      ? "- Do not implement the requirement itself."
      : "- Do not implement the issue itself.",
    "- You may add or update ADRs, design notes, workflow notes, or other guidance docs when they materially reduce design risk.",
    "- Keep guidance minimal but sufficient. Do not write an implementation plan.",
    "- Do not invent new abstractions if existing cross-cutting concerns, schemas, error handling, validation, logging, or workflow patterns already cover the need.",
    "- Repository-wide inspection means the current repository only. Use the working directory or repo-relative paths for any search (grep, find, ripgrep, etc.). Never recursively search `/`, a parent directory, a home directory, `/proc`, or another checkout — `-C`/the sandbox do not confine reads to the repo, so an unscoped search root is never appropriate for a lookup that is inherently repo-scoped.",
    "",
    "Quality bar:",
    "- Hold the upcoming implementation to a top-tier production engineering bar for maintainability, reliability, security, consistency, reuse of existing cross-cutting concerns, clear boundaries, and avoidance of abstraction or concept confusion.",
    "- Call out all gotchas and guardrails up front. Do not silently omit concerns because they seem low priority.",
    "",
  ];

  // Vocabulary section (#931). Optional per-repo. The preflight's job is to
  // identify the SUBSET of the vocabulary that applies to this change so the
  // pre-push reviewers can anchor their architectural_read on the same dialect.
  if (vocabulary != null) {
    lines.push(
      ...buildVocabularySection(vocabulary),
      "",
      "Final response MUST include a section titled \"Design Vocabulary That Applies\" — a filtered subset of the vocabulary above listing the patterns, canonical helpers, boundary contract entries, binding ADRs, and anti-recommendations that the proposed work touches. The reviewers consume this section, so keep it accurate and bounded to what the diff will plausibly intersect.",
      "",
    );
  }

  if (hasRequirement) {
    lines.push(
      "Requirement payload:",
      JSON.stringify(requirement, null, 2),
      "",
      "Existing traceability summary:",
      JSON.stringify(traceabilitySummary, null, 2),
      "",
    );
  } else {
    lines.push(
      "Requirement payload: none.",
      "This is a requirement-free run (bug, refactor, or maintenance). There is no formal Ground Control requirement attached — the GitHub issue below is the authoritative contract. Treat its title, body, and acceptance criteria as the source of truth for what must ship, and apply the same production-readiness bar as any requirement-backed run.",
      "",
    );
  }

  lines.push(
    "GitHub issue context:",
    JSON.stringify(issueContext, null, 2),
    "",
    "Required focus:",
    "- Identify existing cross-cutting concerns, schemas, validation layers, exception handling, logging/observability, security patterns, persistence patterns, and workflow conventions that implementation must reuse.",
    "- Identify risks of concept conflation, leaky abstractions, duplicate schemas, duplicate validation, duplicate exception hierarchies, or duplicate workflow logic.",
    "- Identify where existing contracts, schemas, controllers, DTOs, services, repositories, exception handling, logging, or testing patterns already solve part of the problem.",
    "- Add or update ADRs/design docs only if needed to lock in guardrails or clarify boundaries.",
    "- State explicit non-goals and anti-patterns to avoid.",
    "",
    "Design-up-front, repo-wide — not file-locally. The implementation that follows you will design the change with the file or feature in front of it; your job is to make it design with the repository in front of it. For the change this requirement/issue calls for, evaluate the intended design against ALL FOUR of:",
    "- Security: every cross-cutting layer the design passes through that has a validate()/shape-check/parser/policy gate — the auth surface, the secret-handling surface, env-binding shapes, config validators, OS-level exposure (e.g. a token in process argv), error-envelope leakage. Name each layer the design touches and how it satisfies it. A design that 'sits correctly within the edited file's existing style' but fails a validator outside that file is exactly the failure to catch here.",
    "- Maintainability: every place in the repo that already does this kind of thing. Reuse the existing helper/config/script before inventing a new one. Name the canonical incumbents the implementation must build on.",
    "- Extensibility: the next reasonable change in the same direction. Does the design foreclose it? Is it parameterized so one obvious future variation does not require re-editing the canonical artifact? Call out where a parameter/seam belongs.",
    "- Whole-repo view: the canonical configs, the canonical scripts, the cross-cutting rules, and the host/OS/runtime layers that will see the artifact — not just the file being edited. Enumerate the ones in scope.",
    "",
    "Final response requirements:",
    "- List files changed.",
    "- Summarize architecture decisions and guardrails.",
    "- Summarize required cross-cutting concerns to reuse.",
    "- For the intended design, state which cross-cutting layers it must pass (security validators, config shapes, OS-level exposure, error envelopes) and how it satisfies each; name the canonical incumbents it must build on; and call out the seam/parameter the extensibility view requires.",
    "- Summarize gotchas and anti-patterns to avoid.",
    "- Summarize non-goals and implementation boundaries.",
    "",
    hasRequirement
      ? "Do not spend time re-fetching requirement details if the provided payload is sufficient."
      : "Do not spend time re-fetching issue details if the provided context is sufficient.",
  );

  return lines.join("\n");
}
export const PLUGIN_TYPES = [
  "PACK_HANDLER",
  "REGISTRY_BACKEND",
  "VALIDATOR",
  "POLICY_HOOK",
  "VERIFIER",
  "EMBEDDING_PROVIDER",
  "GRAPH_CONTRIBUTOR",
  "CUSTOM",
];
export const PLUGIN_LIFECYCLE_STATES = ["CREATED", "INITIALIZED", "STARTED", "STOPPED", "FAILED"];
