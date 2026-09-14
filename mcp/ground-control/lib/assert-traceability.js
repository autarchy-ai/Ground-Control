// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { readRequirementByUid } from "./requirement-files.js";
import { createGitHubIssue, formatIssueBody } from "./codex-workflow-3.js";

export async function createGitHubIssueFromRequirement(
  { uid, project, repo, repoRoot: repoPath, labels, extraBody },
  { workspaceAuthorizationResolver = undefined } = {},
) {
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new Error("createGitHubIssueFromRequirement: 'uid' is required");
  }
  // Issue creation spends the MCP host's credentials, so it targets only the launch workspace's
  // repository, and the requirement it renders is read from that checkout (issue #1583).
  const repository = await resolveAuthorizedIssueRepository(repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) {
    return issueRepositoryNotAuthorized("create_issue", repository, { requirement_uid: uid });
  }
  const { repoRoot } = repository;
  // Requirements are repo-local files now (issue #1500): read the requirement from
  // docs/requirements/<UID>/requirement.md. A missing file aborts before any GitHub
  // issue is created — the same fail-fast the former REST 404 gave.
  const req = await readRequirementByUid(repoRoot, uid);
  if (!req?.id) {
    throw new Error(`createGitHubIssueFromRequirement: requirement '${uid}' not found`);
  }

  // The issue title is a single line. The requirement title arrives as
  // `folder_title` (toSnakeCase renames `title` → `folder_title` on responses);
  // fall back to `title` for direct callers. Reuse formatIssueBody's
  // whitespace-collapse rule so a multiline/markdown title cannot inject
  // structure into the title (the body's `## Requirements` bullet is sanitized
  // the same way).
  const titleValue = req.folder_title ?? req.title;
  const titleText = titleValue ? titleValue.replace(/\s+/g, " ").trim() : "";
  const title = titleText ? `${req.uid} — ${titleText}` : req.uid;
  const body = formatIssueBody(req, extraBody);

  const { url, number } = await createGitHubIssue({ title, body, labels, repo, repoRoot });

  // The link back to the requirement lives in the requirement file's `## Traceability`
  // section now, not a backend record — the implementing agent records it there as part
  // of its diff (thin-it, issue #1500). link_type is returned as a hint: ACTIVE
  // requirements are being implemented (IMPLEMENTS), everything else is tracked (DOCUMENTS).
  const linkType = req.status === "ACTIVE" ? "IMPLEMENTS" : "DOCUMENTS";
  return { url, number, requirement_uid: req.uid, link_type: linkType };
}
