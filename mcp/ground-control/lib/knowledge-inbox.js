import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { dump as dumpYaml } from "js-yaml";
import {
  buildInboxSlug,
  defaultSpawnIngest,
  formatInboxTimestamp,
  formatSourceCitation,
} from "./knowledge-capture.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";

function validateWriteKnowledgeInboxArgs({ repoPath, note, tags }) {
  if (typeof repoPath !== "string" || !isAbsolute(repoPath)) {
    return "repo_path must be an absolute path to a Git repository";
  }
  if (typeof note !== "string" || note.trim() === "") {
    return "note is required and must be a non-empty string";
  }
  if (tags != null && !Array.isArray(tags)) {
    return "tags must be an array of strings when set";
  }
  return null;
}

async function resolveKnowledgeCaptureContext(repoPath) {
  let context;
  try {
    context = await getRepoGroundControlContext(repoPath);
  } catch (error) {
    return { ok: false, error: `failed to resolve repo context: ${error.message}` };
  }
  if (context.status !== "ok") {
    return {
      ok: false,
      error: `repository is not ready for knowledge capture: ${context.errors?.[0] || context.status}`,
    };
  }
  if (context.knowledge == null) {
    return {
      ok: false,
      error: "repository has no 'knowledge' block in .ground-control.yaml — capture is not configured",
    };
  }
  return { ok: true, context };
}

function writeInboxFileAtomically(tmpPath, absInboxFile, fileContent) {
  let fd;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- contained repo path
    fd = openSync(tmpPath, "wx");
    writeSync(fd, fileContent);
    fsyncSync(fd);
  } catch (error) {
    if (fd != null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return `failed to write inbox tmp file: ${error.message}`;
  }
  try {
    closeSync(fd);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- contained repo path
    renameSync(tmpPath, absInboxFile);
  } catch (error) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return `failed to finalize inbox file: ${error.message}`;
  }
  return null;
}

export async function writeKnowledgeInbox({
  repoPath,
  note,
  sourceType,
  sourceRef,
  tags = [],
  spawnIngest = defaultSpawnIngest,
} = {}) {
  const argError = validateWriteKnowledgeInboxArgs({ repoPath, note, tags });
  if (argError) return { ok: false, error: argError };

  const citationResult = formatSourceCitation({ sourceType, sourceRef });
  if (!citationResult.ok) return { ok: false, error: citationResult.error };

  const contextResult = await resolveKnowledgeCaptureContext(repoPath);
  if (!contextResult.ok) return contextResult;
  const { context } = contextResult;
  const repoRoot = context.repo_path;
  const knowledge = context.knowledge;
  const inboxRel = knowledge.inbox;
  const absInboxDir = resolvePath(repoRoot, inboxRel);

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- configured contained path
    mkdirSync(absInboxDir, { recursive: true });
  } catch (error) {
    return { ok: false, error: `failed to create inbox directory ${inboxRel}: ${error.message}` };
  }

  const timestamp = formatInboxTimestamp();
  const slug = buildInboxSlug(note);
  const suffix = randomBytes(3).toString("hex").slice(0, 4);
  const absInboxFile = join(absInboxDir, `${timestamp}-${suffix}-${slug}.md`);
  const frontmatter = {
    captured_at: new Date().toISOString(),
    source: citationResult.citation,
    ...(tags.length > 0 ? { tags } : {}),
  };
  const fileContent = `---\n${dumpYaml(frontmatter, { lineWidth: -1, noRefs: true })}---\n\n${note.trim()}\n`;
  const writeError = writeInboxFileAtomically(`${absInboxFile}.tmp`, absInboxFile, fileContent);
  if (writeError) return { ok: false, error: writeError };

  let warning = null;
  try {
    spawnIngest({ repoRoot, inboxFilePath: absInboxFile, knowledge });
  } catch (error) {
    warning = `ingest_spawn_failed: ${error.message}`;
  }
  return {
    ok: true,
    inbox_path: relative(repoRoot, absInboxFile),
    citation: citationResult.citation,
    ...(warning ? { warning } : {}),
  };
}
