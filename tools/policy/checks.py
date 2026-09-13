"""Compatibility barrel for repository policy checks.

Policy implementations live in focused sibling modules. Attribute lookup keeps
the historical ``tools.policy.checks`` import surface without a 169-name set of
static re-export imports that analyzers correctly treat as unused locally.
"""

from . import adr_guard
from . import authz_matrix
from . import ci_strictness
from . import cli
from . import cli_safety
from . import core
from . import decision_records
from . import documentation_coverage
from . import execution_contract
from . import file_size
from . import repo_identity
from . import requirement_specs
from . import version_mirror
from . import workflow_routing
from . import workflow_contracts


_EXPORT_MODULES = (
    core,
    cli_safety,
    file_size,
    ci_strictness,
    adr_guard,
    version_mirror,
    requirement_specs,
    repo_identity,
    authz_matrix,
    decision_records,
    documentation_coverage,
    workflow_routing,
    execution_contract,
    workflow_contracts,
    cli,
)

__all__ = sorted(
    {
        name
        for module in _EXPORT_MODULES
        for name in vars(module)
        if not name.startswith("_")
    }
)


def __getattr__(name: str) -> object:
    """Resolve a historical barrel export from its focused owner module."""
    for module in _EXPORT_MODULES:
        try:
            return getattr(module, name)
        except AttributeError:
            continue
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    """Expose the compatibility surface to introspection and IDE tooling."""
    return sorted({*globals(), *(__all__)})
