import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runPython(script: string) {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  const errors: string[] = [];
  for (const candidate of candidates) {
    const args = candidate === "py" ? ["-3", "-c", script] : ["-c", script];
    const result = spawnSync(candidate, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: "comfy-runtime",
        PYTHONWARNINGS: "error",
      },
    });
    if (result.error) {
      errors.push(`${candidate}: ${result.error.message}`);
      continue;
    }
    return result;
  }
  throw new Error(`Unable to launch Python: ${errors.join("; ")}`);
}

const pythonTest = String.raw`
import asyncio
import gc
import inspect
import json
import pathlib
import sys
import tempfile
import types
import warnings
from unittest.mock import AsyncMock

import launch_comfy
from profile_audit import build_dependency_audit


def write_profile(directory, name, profile):
    profile = dict(profile)
    profile["profileSha256"] = launch_comfy.profile_sha256(profile)
    (directory / f"{name}.json").write_text(json.dumps(profile), encoding="utf-8")
    return profile


def base_profile(files):
    return {
        "schemaVersion": 1,
        "profile": "production_minimal",
        "status": "verified",
        "builtinExtraFiles": files,
        "requiredNodeClasses": ["NodeA", "NodeB", "NodeC"],
    }


assert inspect.iscoroutinefunction(launch_comfy.load_profile_builtin_extra_nodes)
source = pathlib.Path("comfy-runtime/launch_comfy.py").read_text(encoding="utf-8")
assert "async def init_profile_builtin_extra_nodes" in source
assert "await load_profile_builtin_extra_nodes" in source
assert "asyncio.gather" not in source
assert "create_task" not in source
assert "asyncio.run" not in source

with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    extras = root / "comfy_extras"
    extras.mkdir()
    files = [
        "comfy_extras/nodes_a.py",
        "comfy_extras/nodes_b.py",
        "comfy_extras/nodes_c.py",
    ]
    for relative in files:
        (root / relative).write_text("# fixture\n", encoding="utf-8")

    events = []

    async def ordered_loader(path, module_parent):
        events.append(("awaited", pathlib.Path(path).name, module_parent))
        return True

    nodes = types.SimpleNamespace(load_custom_node=AsyncMock(side_effect=ordered_loader))
    failed = asyncio.run(launch_comfy.load_profile_builtin_extra_nodes(nodes, base_profile(files), root))
    assert failed == []
    assert [event[1] for event in events] == ["nodes_a.py", "nodes_b.py", "nodes_c.py"]
    assert all(event[2] == "comfy_extras" for event in events)
    assert nodes.load_custom_node.await_count == 3

    nodes_false = types.SimpleNamespace(load_custom_node=AsyncMock(return_value=False))
    failed = asyncio.run(launch_comfy.load_profile_builtin_extra_nodes(nodes_false, base_profile([files[0]]), root))
    assert failed == [files[0]]
    nodes_false.load_custom_node.assert_awaited_once()

    async def raising_loader(path, module_parent):
        raise RuntimeError("boom")

    nodes_raise = types.SimpleNamespace(load_custom_node=AsyncMock(side_effect=raising_loader))
    failed = asyncio.run(launch_comfy.load_profile_builtin_extra_nodes(nodes_raise, base_profile([files[0]]), root))
    assert failed == [files[0]]
    nodes_raise.load_custom_node.assert_awaited_once()

    async def nested_coroutine_loader(path, module_parent):
        async def inner():
            return True
        return inner()

    nodes_nested = types.SimpleNamespace(load_custom_node=AsyncMock(side_effect=nested_coroutine_loader))
    failed = asyncio.run(launch_comfy.load_profile_builtin_extra_nodes(nodes_nested, base_profile([files[0]]), root))
    assert failed == [files[0]]

    class FakeNodes:
        NODE_CLASS_MAPPINGS = {}

    fake_nodes = FakeNodes()

    async def registering_loader(path, module_parent):
        events.append(("profile-await", pathlib.Path(path).name))
        if path.endswith("nodes_a.py"):
            fake_nodes.NODE_CLASS_MAPPINGS["NodeA"] = object
        if path.endswith("nodes_b.py"):
            fake_nodes.NODE_CLASS_MAPPINGS["NodeB"] = object
        if path.endswith("nodes_c.py"):
            fake_nodes.NODE_CLASS_MAPPINGS["NodeC"] = object
        return True

    fake_nodes.load_custom_node = AsyncMock(side_effect=registering_loader)
    sys.modules["nodes"] = fake_nodes
    launch_comfy.COMFY_DIR = root
    launch_comfy.patch_node_profile(base_profile(files))
    assert inspect.iscoroutinefunction(fake_nodes.init_builtin_extra_nodes)
    asyncio.run(fake_nodes.init_builtin_extra_nodes())
    assert set(fake_nodes.NODE_CLASS_MAPPINGS) == {"NodeA", "NodeB", "NodeC"}
    assert [event[1] for event in events if event[0] == "profile-await"] == ["nodes_a.py", "nodes_b.py", "nodes_c.py"]

with tempfile.TemporaryDirectory() as tmp:
    profile_dir = pathlib.Path(tmp)
    launch_comfy.PROFILE_DIR = profile_dir
    try:
        launch_comfy.load_profile("missing")
    except RuntimeError as exc:
        assert "unknown node profile" in str(exc)
    else:
        raise AssertionError("unknown profile must fail closed")

    profile = base_profile(["comfy_extras/nodes_a.py"])
    profile["profileSha256"] = "0" * 64
    (profile_dir / "bad-sha.json").write_text(json.dumps(profile), encoding="utf-8")
    try:
        launch_comfy.load_profile("bad_sha")
    except RuntimeError as exc:
        assert "sha256 mismatch" in str(exc)
    else:
        raise AssertionError("profile sha drift must fail closed")

    duplicate = write_profile(profile_dir, "duplicate", base_profile(["comfy_extras/nodes_a.py", "comfy_extras/nodes_a.py"]))
    assert duplicate["profileSha256"] == launch_comfy.profile_sha256(duplicate)
    try:
        launch_comfy.load_profile("duplicate")
    except RuntimeError as exc:
        assert "duplicate builtin extra" in str(exc)
    else:
        raise AssertionError("duplicate builtin extra files must fail closed")


async def intentionally_orphaned():
    return True

with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always", RuntimeWarning)
    orphan = intentionally_orphaned()
    del orphan
    gc.collect()
    assert any("was never awaited" in str(item.message) for item in caught)

v3_events = []

async def comfy_entrypoint():
    v3_events.append("comfy_entrypoint")

async def on_load():
    v3_events.append("on_load")

async def get_node_list():
    v3_events.append("get_node_list")
    return {"V3Node": object}

async def v3_loader(path, module_parent):
    await comfy_entrypoint()
    await on_load()
    mapping = await get_node_list()
    v3_nodes.NODE_CLASS_MAPPINGS.update(mapping)
    return True

with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    (root / "comfy_extras").mkdir()
    (root / "comfy_extras" / "nodes_v3.py").write_text("# fixture\n", encoding="utf-8")
    v3_nodes = types.SimpleNamespace(NODE_CLASS_MAPPINGS={}, load_custom_node=AsyncMock(side_effect=v3_loader))
    failed = asyncio.run(
        launch_comfy.load_profile_builtin_extra_nodes(
            v3_nodes,
            {"builtinExtraFiles": ["comfy_extras/nodes_v3.py"]},
            root,
        )
    )
    assert failed == []
    assert v3_events == ["comfy_entrypoint", "on_load", "get_node_list"]
    assert "V3Node" in v3_nodes.NODE_CLASS_MAPPINGS

with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    extras = root / "comfy_extras"
    extras.mkdir()
    (extras / "nodes_flux.py").write_text("from comfy_extras import nodes_clean\n", encoding="utf-8")
    (extras / "nodes_clean.py").write_text("VALUE = 1\n", encoding="utf-8")
    (extras / "nodes_wan.py").write_text("import importlib\nimportlib.import_module(dynamic_name)\n", encoding="utf-8")
    (extras / "nodes_latent.py").write_text("from comfy_extras import nodes_post_processing\n", encoding="utf-8")
    (extras / "nodes_post_processing.py").write_text("import kornia\n", encoding="utf-8")

    audit = build_dependency_audit(
        root,
        {"builtinExtraFiles": ["comfy_extras/nodes_flux.py", "comfy_extras/nodes_wan.py"]},
    )
    assert audit["hasRisk"] is False, audit
    assert audit["files"]["comfy_extras/nodes_wan.py"]["dynamicImports"] == ["line:2:importlib.import_module"]

    risky = build_dependency_audit(root, {"builtinExtraFiles": ["comfy_extras/nodes_latent.py"]})
    assert risky["hasRisk"] is True
    assert "comfy_extras/nodes_post_processing.py" in risky["files"]["comfy_extras/nodes_latent.py"]["transitiveRisks"]

gc.collect()
print("async_loader_contract=passed")
`;

const result = runPython(pythonTest);
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /async_loader_contract=passed/);

console.log("Comfy async loader tests passed");
