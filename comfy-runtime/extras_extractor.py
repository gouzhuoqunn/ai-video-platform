from __future__ import annotations

import ast
import hashlib
import os


TARGET_FUNCTION = "init_builtin_extra_nodes"
TARGET_VARIABLE = "extras_files"


class BuiltinExtraExtractionError(RuntimeError):
    pass


def extract_builtin_extra_files(nodes_source: str) -> list[str]:
    tree = ast.parse(nodes_source)
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == TARGET_FUNCTION
    ]
    if len(functions) != 1:
        raise BuiltinExtraExtractionError(f"expected exactly one {TARGET_FUNCTION} function")

    assignments: list[ast.List | ast.Tuple] = []
    for statement in functions[0].body:
        if isinstance(statement, ast.Assign):
            matching_targets = [
                target
                for target in statement.targets
                if isinstance(target, ast.Name) and target.id == TARGET_VARIABLE
            ]
            if matching_targets:
                assignments.append(statement.value)
        elif isinstance(statement, ast.AnnAssign):
            target = statement.target
            if isinstance(target, ast.Name) and target.id == TARGET_VARIABLE and statement.value is not None:
                assignments.append(statement.value)

    if len(assignments) != 1:
        raise BuiltinExtraExtractionError(f"expected exactly one {TARGET_VARIABLE} assignment")

    value = assignments[0]
    if not isinstance(value, (ast.List, ast.Tuple)):
        raise BuiltinExtraExtractionError(f"{TARGET_VARIABLE} must be a list or tuple literal")

    files: list[str] = []
    for element in value.elts:
        if not isinstance(element, ast.Constant) or not isinstance(element.value, str):
            raise BuiltinExtraExtractionError(f"{TARGET_VARIABLE} entries must be string constants")
        files.append(element.value)

    validate_builtin_extra_files(files)
    return files


def validate_builtin_extra_files(files: list[str]) -> None:
    if not files:
        raise BuiltinExtraExtractionError(f"{TARGET_VARIABLE} must not be empty")
    if len(set(files)) != len(files):
        raise BuiltinExtraExtractionError(f"{TARGET_VARIABLE} must not contain duplicates")

    for filename in files:
        if os.path.basename(filename) != filename:
            raise BuiltinExtraExtractionError(f"builtin extra must be a basename: {filename}")
        if not filename.startswith("nodes_") or not filename.endswith(".py"):
            raise BuiltinExtraExtractionError(f"builtin extra has invalid naming pattern: {filename}")
        if "/" in filename or "\\" in filename or ".." in filename:
            raise BuiltinExtraExtractionError(f"builtin extra contains path traversal: {filename}")


def builtin_extra_list_sha256(files: list[str]) -> str:
    payload = "\n".join(files) + "\n"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
