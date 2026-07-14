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
      env: { ...process.env, PYTHONPATH: "comfy-runtime" },
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
import ast
import hashlib
import pathlib

from extras_extractor import BuiltinExtraExtractionError, builtin_extra_list_sha256, extract_builtin_extra_files


def expect_error(source, message):
    try:
        extract_builtin_extra_files(source)
    except BuiltinExtraExtractionError:
        return
    raise AssertionError(message)


async_source = '''
async def init_builtin_extra_nodes():
    extras_files = ("nodes_alpha.py", "nodes_beta.py")
'''
assert extract_builtin_extra_files(async_source) == ["nodes_alpha.py", "nodes_beta.py"]

def_source = '''
def init_builtin_extra_nodes():
    extras_files = ["nodes_alpha.py", "nodes_beta.py"]
'''
assert extract_builtin_extra_files(def_source) == ["nodes_alpha.py", "nodes_beta.py"]

fixture_path = pathlib.Path("comfy-runtime/fixtures/comfyui-init-builtin-extra-nodes-da260892.py")
fixture = fixture_path.read_text(encoding="utf-8")
files = extract_builtin_extra_files(fixture)
assert len(files) > 100, len(files)
assert files[:4] == [
    "nodes_latent.py",
    "nodes_hypernetwork.py",
    "nodes_upscale_model.py",
    "nodes_post_processing.py",
]
for required in ["nodes_flux.py", "nodes_video.py", "nodes_wan.py"]:
    assert required in files

module = ast.parse(fixture)
function = next(node for node in module.body if isinstance(node, ast.AsyncFunctionDef))
segment = ast.get_source_segment(fixture, function)
assert segment is not None
print("fixture_function_sha256=" + hashlib.sha256(segment.encode("utf-8")).hexdigest())
print("fixture_extra_count=" + str(len(files)))
print("fixture_extra_list_sha256=" + builtin_extra_list_sha256(files))

expect_error("x = 1", "missing target function must fail")
expect_error(
    "def init_builtin_extra_nodes():\n    extras_files = ['nodes_a.py']\n"
    "def init_builtin_extra_nodes():\n    extras_files = ['nodes_b.py']\n",
    "duplicate target functions must fail",
)
expect_error(
    "async def init_builtin_extra_nodes():\n    extras_files = ['nodes_a.py']\n    extras_files = ['nodes_b.py']\n",
    "multiple assignments must fail",
)
expect_error(
    "async def init_builtin_extra_nodes():\n    extras_files = sorted(['nodes_a.py'])\n",
    "dynamic expressions must fail",
)
expect_error(
    "async def init_builtin_extra_nodes():\n    extras_files = ['nodes_a.py', 7]\n",
    "non-string entries must fail",
)
expect_error(
    "async def init_builtin_extra_nodes():\n    extras_files = ['../nodes_a.py']\n",
    "path traversal entries must fail",
)
expect_error(
    "async def init_builtin_extra_nodes():\n    extras_files = ['nodes_a.py', 'nodes_a.py']\n",
    "duplicate entries must fail",
)

def old_extractor(source):
    tree = ast.parse(source)
    extras_files = None
    for function in [item for item in tree.body if isinstance(item, ast.FunctionDef)]:
        if function.name != "init_builtin_extra_nodes":
            continue
        for statement in ast.walk(function):
            if isinstance(statement, ast.Assign):
                for target in statement.targets:
                    if isinstance(target, ast.Name) and target.id == "extras_files":
                        extras_files = ast.literal_eval(statement.value)
    return extras_files

assert old_extractor(fixture) is None
assert files[0] == "nodes_latent.py"
`;

const result = runPython(pythonTest);
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /fixture_function_sha256=[a-f0-9]{64}/);
assert.match(result.stdout, /fixture_extra_count=\d+/);
assert.match(result.stdout, /fixture_extra_list_sha256=[a-f0-9]{64}/);

console.log("Comfy extras extractor tests passed");
