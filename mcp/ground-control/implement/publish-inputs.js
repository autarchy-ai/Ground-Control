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
// A module named `credential(s).<source-ext>` is ordinary application code, not
// a credential artifact (issue #1649). Only source extensions are listed, so
// `credentials.json`, `credentials.yaml` and a bare `credentials` entry stay
// sensitive; secrets *inside* a source file remain the secret scanner's job.
// Command-script extensions are deliberately absent (issue #1679): a
// `credentials.sh` is idiomatically a `source`-me credential loader rather than
// an application module, and the publisher stages untracked files with
// `git add -A`, so exempting the basename would carry it into the commit.
const SOURCE_MODULE_EXTENSIONS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "pyi", "rb", "go",
  "rs", "java", "kt", "kts", "cs", "php", "swift", "scala", "c", "cc",
  "cpp", "h", "hpp",
]);
function isCredentialSourceModule(basename) {
  const [stem, extension, ...rest] = basename.toLowerCase().split(".");
  return rest.length === 0
    && (stem === "credential" || stem === "credentials")
    && SOURCE_MODULE_EXTENSIONS.has(extension);
}
export function isSensitivePublishPath(path) {
  const basename = path.split("/").at(-1);
  const sensitiveEnv =
    /^\.env(?:\.|$)/i.test(basename)
    && !/^\.env\.(?:example|sample|template)$/i.test(basename);
  if (sensitiveEnv) return true;
  // Exempting the basename must not exempt its location: a source module inside
  // a secret-bearing directory is still sensitive by where it sits.
  const subject = isCredentialSourceModule(basename)
    ? path.slice(0, path.length - basename.length)
    : path;
  return SENSITIVE_STAGED_PATH_RE.test(subject);
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
