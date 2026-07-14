from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
from typing import Any

from extras_extractor import builtin_extra_list_sha256, extract_builtin_extra_files


EXPECTED_NODES_SHA256 = "aecd111cf3f1ccf5a5ca6b4293d47dfe236f9a717e5190cbb6a66a03afb8d009"
RISK_MODULES = {"kornia"}
RISK_FILES = {
    "comfy_extras/nodes_latent.py",
    "comfy_extras/nodes_post_processing.py",
    "comfy_extras/nodes_canny.py",
    "comfy_extras/nodes_morphology.py",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def profile_sha256(profile: dict[str, Any]) -> str:
    canonical = dict(profile)
    canonical.pop("profileSha256", None)
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def literal_string_keys(value: ast.AST) -> list[str]:
    if not isinstance(value, ast.Dict):
        return []
    keys: list[str] = []
    for key in value.keys:
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            keys.append(key.value)
        else:
            return []
    return keys


def call_attribute_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = call_attribute_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def literal_update_keys(statement: ast.AST) -> list[str]:
    if not isinstance(statement, ast.Expr) or not isinstance(statement.value, ast.Call):
        return []
    call = statement.value
    if call_attribute_name(call.func) != "NODE_CLASS_MAPPINGS.update" or len(call.args) != 1:
        return []
    return literal_string_keys(call.args[0])


def schema_node_ids(tree: ast.Module) -> list[str]:
    node_ids: list[str] = []
    for statement in tree.body:
        if not isinstance(statement, ast.ClassDef):
            continue
        for child in statement.body:
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) or child.name != "define_schema":
                continue
            for node in ast.walk(child):
                if not isinstance(node, ast.Return) or not isinstance(node.value, ast.Call):
                    continue
                func_name = call_attribute_name(node.value.func)
                if not func_name.endswith(".Schema") and func_name != "Schema":
                    continue
                for keyword in node.value.keywords:
                    if (
                        keyword.arg == "node_id"
                        and isinstance(keyword.value, ast.Constant)
                        and isinstance(keyword.value.value, str)
                    ):
                        node_ids.append(keyword.value.value)
    return node_ids


def extract_node_class_mappings(source: str) -> list[str]:
    tree = ast.parse(source)
    mappings: list[str] = []
    for statement in tree.body:
        value: ast.AST | None = None
        if isinstance(statement, ast.Assign):
            if any(isinstance(target, ast.Name) and target.id == "NODE_CLASS_MAPPINGS" for target in statement.targets):
                value = statement.value
        elif isinstance(statement, ast.AnnAssign):
            target = statement.target
            if isinstance(target, ast.Name) and target.id == "NODE_CLASS_MAPPINGS":
                value = statement.value
        if value is not None:
            mappings.extend(literal_string_keys(value))
        mappings.extend(literal_update_keys(statement))
    mappings.extend(schema_node_ids(tree))
    return list(dict.fromkeys(mappings))


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def module_to_relative_file(module: str) -> str:
    if module.startswith("comfy_extras."):
        return module.replace(".", "/") + ".py"
    if module.startswith("nodes_"):
        return "comfy_extras/" + module + ".py"
    return ""


def import_name_from_alias(module: str, alias: ast.alias) -> str:
    if module == "comfy_extras":
        return f"comfy_extras.{alias.name}"
    if module:
        return module
    return alias.name


def imported_module_names(tree: ast.Module) -> tuple[list[str], list[str]]:
    imports: list[str] = []
    dynamic_imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level and (module.startswith("nodes_") or not module):
                module = f"comfy_extras.{module}".rstrip(".")
            for alias in node.names:
                imports.append(import_name_from_alias(module, alias))
        elif isinstance(node, ast.Call):
            name = call_attribute_name(node.func)
            if name in {"importlib.import_module", "__import__"}:
                if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    imports.append(node.args[0].value)
                else:
                    dynamic_imports.append(f"line:{getattr(node, 'lineno', 0)}:{name}")
    return list(dict.fromkeys(imports)), dynamic_imports


def build_dependency_audit(comfy_dir: Path, profile: dict[str, Any]) -> dict[str, Any]:
    extras_dir = comfy_dir / "comfy_extras"
    graph: dict[str, dict[str, Any]] = {}
    for source_path in sorted(extras_dir.glob("*.py")):
        relative = str(source_path.relative_to(comfy_dir)).replace("\\", "/")
        tree = ast.parse(source_path.read_text(encoding="utf-8", errors="replace"), filename=str(source_path))
        direct_imports, dynamic_imports = imported_module_names(tree)
        resolved = sorted(
            {
                relative_file
                for name in direct_imports
                for relative_file in [module_to_relative_file(name)]
                if relative_file and (comfy_dir / relative_file).is_file()
            }
        )
        graph[relative] = {
            "directImports": direct_imports,
            "dynamicImports": dynamic_imports,
            "resolvedLocalImports": resolved,
        }

    files: dict[str, dict[str, Any]] = {}
    for start in profile.get("builtinExtraFiles", []):
        visited: set[str] = set()
        risks: set[str] = set()
        stack = [start]
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            node = graph.get(current, {"directImports": [], "resolvedLocalImports": [], "dynamicImports": []})
            for imported in node["directImports"]:
                if imported.split(".", 1)[0] in RISK_MODULES:
                    risks.add(imported)
            for relative_file in node["resolvedLocalImports"]:
                if relative_file in RISK_FILES:
                    risks.add(relative_file)
                if relative_file not in visited:
                    stack.append(relative_file)

        node = graph.get(start)
        if node is None:
            raise RuntimeError(f"profile builtin extra missing from ComfyUI source: {start}")
        files[start] = {
            "directImports": node["directImports"],
            "dynamicImports": node["dynamicImports"],
            "resolvedLocalImports": node["resolvedLocalImports"],
            "transitiveLocalImports": sorted(visited.difference({start})),
            "transitiveRisks": sorted(risks),
        }

    risk_files = {
        file_name: details["transitiveRisks"]
        for file_name, details in files.items()
        if details["transitiveRisks"]
    }
    return {
        "profileBuiltinExtraFiles": profile.get("builtinExtraFiles", []),
        "riskModules": sorted(RISK_MODULES),
        "riskFiles": sorted(RISK_FILES),
        "files": files,
        "riskFilesByProfileExtra": risk_files,
        "hasRisk": bool(risk_files),
    }


def build_profile_diagnostics(comfy_dir: Path, runtime_dir: Path, profile_path: Path) -> dict[str, Any]:
    nodes_path = comfy_dir / "nodes.py"
    nodes_source = nodes_path.read_text(encoding="utf-8")
    nodes_sha = hashlib.sha256(nodes_source.encode("utf-8")).hexdigest()
    if nodes_sha != EXPECTED_NODES_SHA256:
        raise RuntimeError(f"nodes.py sha256 mismatch: expected {EXPECTED_NODES_SHA256}, got {nodes_sha}")

    extras = extract_builtin_extra_files(nodes_source)
    manifest_path = runtime_dir / "workflows" / "official" / "manifest.json"
    manifest = read_json(manifest_path)
    profile = read_json(profile_path)

    required = sorted(
        {
            node_class
            for workflow in manifest.get("workflows", [])
            for node_class in workflow.get("requiredNodeClasses", [])
        }
    )

    mapping_evidence: dict[str, str] = {}
    base_node_classes = extract_node_class_mappings(nodes_source)
    for node_class in base_node_classes:
        mapping_evidence[node_class] = "nodes.py"

    extras_dir = comfy_dir / "comfy_extras"
    extra_mappings: dict[str, list[str]] = {}
    for filename in extras:
        source_path = extras_dir / filename
        classes = extract_node_class_mappings(source_path.read_text(encoding="utf-8", errors="replace"))
        if classes:
            relative = f"comfy_extras/{filename}"
            extra_mappings[relative] = classes
            for node_class in classes:
                mapping_evidence.setdefault(node_class, relative)

    missing = sorted(node_class for node_class in required if node_class not in mapping_evidence)
    required_extra_files = sorted(
        {mapping_evidence[node_class] for node_class in required if mapping_evidence.get(node_class, "nodes.py") != "nodes.py"}
    )
    profile_builtin = sorted(profile.get("builtinExtraFiles", []))
    profile_required = sorted(profile.get("requiredNodeClasses", []))
    excluded = sorted(f"comfy_extras/{filename}" for filename in extras if f"comfy_extras/{filename}" not in profile_builtin)

    diagnostics = {
        "requiredNodeClasses": required,
        "baseNodeClasses": base_node_classes,
        "builtinExtraFiles": profile_builtin,
        "dependencyAudit": build_dependency_audit(comfy_dir, profile),
        "generatedRequiredBuiltinExtraFiles": required_extra_files,
        "excludedBuiltinExtraFiles": excluded,
        "missingRequiredNodeClasses": missing,
        "mappingEvidence": {node_class: mapping_evidence.get(node_class, "") for node_class in required},
        "comfyuiNodesSha256": nodes_sha,
        "builtinExtraCount": len(extras),
        "builtinExtraListSha256": builtin_extra_list_sha256(extras),
        "workflowManifestSha256": sha256_file(manifest_path),
        "profileSha256": profile_sha256(profile),
        "profileDeclaredSha256": profile.get("profileSha256", ""),
    }

    if missing:
        raise RuntimeError("missing required node classes: " + ", ".join(missing))
    if profile_required != required:
        raise RuntimeError("profile requiredNodeClasses do not match workflow manifest")
    if profile_builtin != required_extra_files:
        raise RuntimeError("profile builtinExtraFiles do not match generated required builtin extras")
    if diagnostics["profileSha256"] != diagnostics["profileDeclaredSha256"]:
        raise RuntimeError("profileSha256 mismatch")
    if diagnostics["dependencyAudit"]["hasRisk"]:
        raise RuntimeError(
            "production_minimal transitive dependency audit found risk imports: "
            + json.dumps(diagnostics["dependencyAudit"]["riskFilesByProfileExtra"], sort_keys=True)
        )
    return diagnostics


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-dir", default="/opt/ComfyUI")
    parser.add_argument("--runtime-dir", default="/opt/comfy-runtime")
    parser.add_argument("--profile", default="/opt/comfy-runtime/node-profiles/production-minimal.json")
    parser.add_argument("--write-diagnostics", default="")
    args = parser.parse_args()

    diagnostics = build_profile_diagnostics(Path(args.comfy_dir), Path(args.runtime_dir), Path(args.profile))
    if args.write_diagnostics:
        path = Path(args.write_diagnostics)
        path.write_text(json.dumps(diagnostics, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print("profile_required_node_count=" + str(len(diagnostics["requiredNodeClasses"])), flush=True)
    print("profile_base_node_count=" + str(len(diagnostics["baseNodeClasses"])), flush=True)
    print("profile_builtin_extra_files=" + ",".join(diagnostics["builtinExtraFiles"]), flush=True)
    print("profile_excluded_builtin_extra_count=" + str(len(diagnostics["excludedBuiltinExtraFiles"])), flush=True)
    print("dependency_audit_has_risk=false", flush=True)
    print("missingRequiredNodeClasses=0", flush=True)
    print("profile_sha256=" + diagnostics["profileSha256"], flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
