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
// A recognized source file is ordinary application code by its extension, so a
// `credential`/`credentials` feature or package directory must not mark it
// sensitive on the directory name alone (issue #1692, follow-up to #1649). A
// non-source credential artifact keeps no source extension, so `credentials.json`,
// `credentials.yaml`, a bare `credentials` entry, and a `credentials.sh`/`.bash`
// credential loader (issue #1679) all stay sensitive through
// SENSITIVE_STAGED_PATH_RE; secrets *inside* a source file remain the secret
// scanner's job.
const SOURCE_MODULE_EXTENSIONS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "pyi", "rb", "go",
  "rs", "java", "kt", "kts", "cs", "php", "swift", "scala", "c", "cc",
  "cpp", "h", "hpp",
]);
function isRecognizedSourceFile(basename) {
  const parts = basename.toLowerCase().split(".");
  return parts.length >= 2 && SOURCE_MODULE_EXTENSIONS.has(parts.at(-1));
}
// The directory chain a path sits in, with `credential`/`credentials` segments
// dropped. Only those namespace directories are removed, so a dedicated secret
// directory survives and still matches SENSITIVE_STAGED_PATH_RE by location.
function nonCredentialLocation(path) {
  return path
    .split("/")
    .slice(0, -1)
    .filter((segment) => !/^credentials?$/i.test(segment))
    .map((segment) => `${segment}/`)
    .join("");
}
export function isSensitivePublishPath(path) {
  const basename = path.split("/").at(-1);
  const sensitiveEnv =
    /^\.env(?:\.|$)/i.test(basename)
    && !/^\.env\.(?:example|sample|template)$/i.test(basename);
  if (sensitiveEnv) return true;
  // A recognized source file's own name and its `credential(s)` directories are
  // ordinary code, so only its remaining location can make it sensitive: a
  // secret directory still does, a credential namespace no longer does.
  if (isRecognizedSourceFile(basename)) {
    return SENSITIVE_STAGED_PATH_RE.test(nonCredentialLocation(path));
  }
  return SENSITIVE_STAGED_PATH_RE.test(path);
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
