"""Closed repository-owned declaration for one sandbox task environment."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass


class DeclarationError(RuntimeError):
    """A repository declaration is malformed or requests unsafe authority."""


@dataclass(frozen=True)
class EnvironmentDeclaration(object):
    """One validated literal or logical secret reference."""

    name: str
    literal: str | None = None
    secret_ref: str | None = None


@dataclass(frozen=True)
class RepositoryEnvironment(object):
    """The validated repository identity and its ordered environment declarations."""

    repository: str
    digest: str
    variables: tuple[EnvironmentDeclaration, ...]


_SCHEMA = "gc.incus-sandbox.task-environment/v1"
_NAME = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
_ALIAS = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_REPOSITORY = re.compile(r"^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$")
_RESERVED_NAMES = {
    "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TERM", "TMPDIR", "PWD", "OLDPWD",
    "DOCKER_HOST", "GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK",
}
_RESERVED_PREFIXES = (
    "LD_", "DYLD_", "GIT_", "SSH_", "PYTHON", "NODE_OPTIONS", "NPM_CONFIG_",
    "BASH_ENV", "ENV", "CDPATH", "CODEX_", "OPENAI_", "GROUND_CONTROL_", "GC_",
)
_MAX_DOCUMENT_BYTES = 64 * 1024
_MAX_VARIABLES = 128
MAX_TASK_FRAME_BYTES = 64 * 1024


def _document(raw: bytes) -> dict[str, object]:
    """Decode the bounded closed declaration document."""
    if not isinstance(raw, bytes) or not raw or len(raw) > _MAX_DOCUMENT_BYTES:
        raise DeclarationError("task environment declaration size is invalid")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DeclarationError("task environment declaration is invalid JSON") from exc
    if not isinstance(document, dict) or set(document) != {"schema", "repository", "variables"}:
        raise DeclarationError("task environment declaration fields are invalid")
    if document.get("schema") != _SCHEMA:
        raise DeclarationError("task environment declaration schema is invalid")
    return document


def _repository(value: object, expected: str) -> str:
    """Require the declaration's canonical repository identity."""
    if not isinstance(value, str) or not _REPOSITORY.fullmatch(value) or value != expected:
        raise DeclarationError("task environment repository identity does not match")
    return value


def valid_environment_name(value: object) -> str:
    """Return one portable, non-authority-bearing environment name."""
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise DeclarationError("task environment variable name is invalid")
    if value in _RESERVED_NAMES or any(value.startswith(prefix) for prefix in _RESERVED_PREFIXES):
        raise DeclarationError("task environment variable name is reserved")
    return value


def _variable(raw: object, max_value_bytes: int) -> EnvironmentDeclaration:
    """Validate one exclusive literal or secret-reference declaration."""
    if not isinstance(raw, dict):
        raise DeclarationError("task environment variable is invalid")
    sources = {"literal", "secret_ref"} & set(raw)
    if set(raw) not in ({"name", "literal"}, {"name", "secret_ref"}) or len(sources) != 1:
        raise DeclarationError("task environment variable source is ambiguous")
    name = valid_environment_name(raw.get("name"))
    if "literal" in raw:
        literal = raw["literal"]
        if not isinstance(literal, str) or "\0" in literal or len(literal.encode("utf-8")) > max_value_bytes:
            raise DeclarationError("task environment literal is invalid")
        return EnvironmentDeclaration(name=name, literal=literal)
    alias = raw["secret_ref"]
    if not isinstance(alias, str) or not _ALIAS.fullmatch(alias):
        raise DeclarationError("task environment secret reference is invalid")
    return EnvironmentDeclaration(name=name, secret_ref=alias)


def parse_repository_environment(raw: bytes, expected_repository: str, *,
                                 max_value_bytes: int = 16 * 1024) -> RepositoryEnvironment:
    """Parse the sole repository declaration format without resolving any value."""
    document = _document(raw)
    repository = _repository(document["repository"], expected_repository)
    variables = document["variables"]
    if not isinstance(variables, list) or len(variables) > _MAX_VARIABLES:
        raise DeclarationError("task environment variables are invalid")
    parsed = tuple(_variable(item, max_value_bytes) for item in variables)
    names = [item.name for item in parsed]
    aliases = [item.secret_ref for item in parsed if item.secret_ref is not None]
    if len(names) != len(set(names)) or len(aliases) != len(set(aliases)):
        raise DeclarationError("task environment names and references must be unique")
    return RepositoryEnvironment(
        repository=repository,
        digest=hashlib.sha256(raw).hexdigest(),
        variables=parsed,
    )
