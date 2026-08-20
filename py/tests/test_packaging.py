"""Guards that the declared dependencies match what the source actually imports.

MissionCtrl composes eight sibling primitives. When one of them is renamed
(``approval-surface`` became ``launchgate``) or a new one is imported without
being declared, ``import missionctrl`` breaks for anyone installing from a
clean environment. These tests fail on that drift instead of shipping it.
"""

from __future__ import annotations

import ast
import pkgutil
import sys
import tomllib
from importlib import import_module
from pathlib import Path

_PY_ROOT = Path(__file__).resolve().parents[1]
_SOURCE_ROOT = _PY_ROOT / "src" / "missionctrl"

# Top-level module name -> the distribution that ships it. Several modules can
# come from one distribution: the axiongraph wheel packages both
# ``axiongraph_core`` and ``axiongraph_store_local``.
_MODULE_DISTRIBUTIONS = {
    "axiongraph_core": "axiongraph",
    "axiongraph_store_local": "axiongraph",
    "cryptography": "cryptography",
    "deltav": "deltav",
    "grantz": "grantz",
    "launchgate": "launchgate",
    "nvoke": "nvoke",
    "plugg": "plugg",
    "verdik": "verdik",
}


def _declared_distributions() -> set[str]:
    manifest = tomllib.loads((_PY_ROOT / "pyproject.toml").read_text())
    declared = set()
    for requirement in manifest["project"]["dependencies"]:
        name = requirement
        for separator in (">=", "==", "<=", "~=", ">", "<", "[", ";"):
            name = name.split(separator)[0]
        declared.add(name.strip())
    return declared


def _imported_modules() -> set[str]:
    imported = set()
    for source_file in sorted(_SOURCE_ROOT.rglob("*.py")):
        tree = ast.parse(source_file.read_text(), filename=str(source_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.split(".")[0])
    return {
        module
        for module in imported
        if module not in sys.stdlib_module_names and module != "missionctrl"
    }


def test_every_imported_module_maps_to_a_known_distribution() -> None:
    unmapped = _imported_modules() - _MODULE_DISTRIBUTIONS.keys()
    assert not unmapped, (
        f"source imports {sorted(unmapped)}, which _MODULE_DISTRIBUTIONS does not map; "
        "add the mapping and declare the distribution in pyproject.toml"
    )


def test_every_imported_distribution_is_declared() -> None:
    required = {_MODULE_DISTRIBUTIONS[module] for module in _imported_modules()}
    missing = required - _declared_distributions()
    assert not missing, f"source imports {sorted(missing)} but pyproject.toml does not declare it"


def test_no_declared_dependency_is_unused() -> None:
    used = {_MODULE_DISTRIBUTIONS[module] for module in _imported_modules()}
    unused = _declared_distributions() - used
    assert not unused, f"pyproject.toml declares {sorted(unused)}, which the source never imports"


def test_every_submodule_imports() -> None:
    package = import_module("missionctrl")
    for module in pkgutil.iter_modules(package.__path__):
        import_module(f"missionctrl.{module.name}")
