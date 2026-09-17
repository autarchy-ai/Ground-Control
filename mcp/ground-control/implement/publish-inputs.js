export function validateCommitMessage(message) {
  if (typeof message !== "string" || message.trim() === "") {
    return "commit_message is required";
  }
  if (/[\r\n]/.test(message)) return "commit_message must be a single line";
  if (/\b(?:codex|claude|chatgpt|openai|anthropic)\b|co-authored-by|generated with/i.test(message)) {
    return "commit_message must not contain assistant or vendor attribution";
  }
  return null;
}
// Sensitive staged paths, as one anchored alternation over three classes: a
// `.secret` directory (optional trailing `s`), a `credential`/`credentials`
// entry, or a private-key or certificate file by extension. The trailing `$`
// sits inside the key-file alternative, so its precedence is explicit (S5850),
// and factoring the shared path-boundary prefix keeps the whole pattern under
// the regex-complexity limit (S5843). Matching is unchanged.
export const SENSITIVE_STAGED_PATH_RE =
  /(?:^|\/)(?:\.secrets?(?:\/|$)|credentials?(?:[./]|$)|[^/]+\.(?:pem|key|p12|pfx)$)/i;
export function isSensitivePublishPath(path) {
  const basename = path.split("/").at(-1);
  const sensitiveEnv =
    /^\.env(?:\.|$)/i.test(basename)
    && !/^\.env\.(?:example|sample|template)$/i.test(basename);
  return sensitiveEnv || SENSITIVE_STAGED_PATH_RE.test(path);
}
export function splitNullPaths(stdout) {
  return stdout.split("\0").filter(Boolean);
}
export async function readPublishPaths(repoRoot, runGit, commandRunner) {
  const [tracked, staged, untracked] = await Promise.all([
    runGit(repoRoot, ["diff", "--name-only", "-z"], commandRunner),
    runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"], commandRunner),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], commandRunner),
  ]);
  return [...new Set([
    ...splitNullPaths(tracked.stdout),
    ...splitNullPaths(staged.stdout),
    ...splitNullPaths(untracked.stdout),
  ])];
}
