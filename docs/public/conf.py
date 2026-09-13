"""Sphinx configuration for the public Ground Control documentation (issue #1587)."""

import json
from pathlib import Path

project = "Ground Control"
author = "Brad Edwards"
copyright = "2026, Brad Edwards"

# The published version is the grndctl package version, which Release Please owns.
_PACKAGE_JSON = Path(__file__).resolve().parents[2] / "mcp" / "ground-control" / "package.json"
release = json.loads(_PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
version = release

extensions = ["myst_parser", "sphinx_copybutton"]
myst_heading_anchors = 3
exclude_patterns = ["_build", "requirements.txt"]

html_theme = "furo"
html_title = "Ground Control"
