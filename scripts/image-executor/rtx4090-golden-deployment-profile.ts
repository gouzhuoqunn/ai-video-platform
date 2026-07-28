import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  ImmutableSourceResolutionError,
  immutablePublicSourceEndpoints,
  resolveImmutableSource,
  type ImmutableSourceEndpoint,
  type ResolvedImmutableSource,
} from "./immutable-source-resolver";

export type Rtx4090GoldenDeploymentProfile = {
  id: "rtx4090-golden-agent-v1";
  gpuClass: "rtx4090";
  supportedDimensions: { maxWidth: 1280; maxHeight: 1280 };
  image: "cloreai/jupyter:ubuntu24.04-v2";
  ports: { "8080": "http" };
  healthPath: "/healthz";
  controllerBind: "0.0.0.0:8080";
  immutable: {
    commit: string;
    agentSourceSha256: string;
    agentSha256: string;
    controllerSourceSha256: string;
    controllerSha256: string;
    workflowSourceSha256: string;
    workflowSha256: string;
  };
  agentContract: "stage-acceptance-v2";
  acceptedStageResponseFields: readonly ["accepted", "state", "status", "stage", "stage_run_id"];
  bootstrapTemplateSha256: string;
};

const immutable = {
  // The published commit contains the accepted controller/workflow and the
  // immediate predecessor of stage-acceptance-v2. The fixed patch below
  // materializes the locally pinned Agent byte-for-byte before it can execute.
  commit: "5c9364c291ea6a10b36024832a8d1e14200889c2",
  agentSourceSha256: "678083c89a96579f7e1bf9f7b9d2783f950d83aba43a57e42d841be4a333af51",
  agentSha256: "52d94b073ee2212bdcc47c8c71b608523e6aa7278383ac83b45a3a2d7bfe8e2c",
  controllerSourceSha256: "96569eb5eee895f974d7b8304bb15f3b38e8f806115aae90f06bf0f8b927563e",
  controllerSha256: "11e1126eed3848f5220da7ad0fd4e14c2e8229a9b7c724a0862f6ddae4a8fc67",
  workflowSourceSha256: "e5b3e4cc7f347888f3231a82068d746740d5cb575905351ac4c7949d4b1cdd0d",
  workflowSha256: "02fdedec5812f82c96f8396f19ed7c0f3600f8ac3c620ff5473d299c3d2c1e80",
} as const;

export const RTX4090_GOLDEN_AGENT_SOURCE_PATCHES = [
  ["\"\"\"Restricted, authenticated Clore image diagnostic agent.\n\nThe only externally reachable service is this agent.  It deliberately exposes\nfixed diagnostics, a fixed five-file model manifest, and one fixed image path;\nit is not a shell, file browser, workflow runner, or general proxy.\n\"\"\"\nfrom __future__ import annotations\n\nimport argparse\nimport http.client\nimport hashlib\n", "\"\"\"Restricted, authenticated Clore image diagnostic agent.\n\nThe only externally reachable service is this agent. It deliberately exposes\nfixed diagnostics, five fixed base models, a bounded verified LoRA extension,\nand one fixed image path; it is not a shell, file browser, workflow runner, or\ngeneral proxy.\n\"\"\"\nfrom __future__ import annotations\n\nimport argparse\nimport base64\nfrom collections import deque\nimport http.client\nimport hashlib\n"],
  ["import urllib.request\nimport uuid\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\nfrom pathlib import Path\n", "import urllib.request\nimport uuid\nimport zlib\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\nfrom pathlib import Path\n"],
  ["PYTORCH_CU128_INDEX = \"https://download.pytorch.org/whl/cu128\"\nTORCH_REQUIREMENTS = (\"torch==2.8.0\", \"torchvision==0.23.0\", \"torchaudio==2.8.0\")\nRAW_ROOT = \"https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform\"\nMAX_TEXT = 6000\nMAX_MODEL_BODY = 64 * 1024\nMAX_INFERENCE_BODY = 16 * 1024\nUUID_RE = re.compile(r\"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$\", re.I)\nSHA_RE = re.compile(r\"^[a-f0-9]{64}$\", re.I)\nCOMMIT_RE = re.compile(r\"^[a-f0-9]{40}$\", re.I)\n", "PYTORCH_CU128_INDEX = \"https://download.pytorch.org/whl/cu128\"\nTORCH_REQUIREMENTS = (\"torch==2.8.0\", \"torchvision==0.23.0\", \"torchaudio==2.8.0\")\nIMMUTABLE_SOURCE_ROOTS = (\n    (\"jsdelivr_commit_cdn\", \"https://cdn.jsdelivr.net/gh/gouzhuoqunn/ai-video-platform\"),\n    (\"github_raw_commit\", \"https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform\"),\n)\nMAX_TEXT = 6000\n# Five signed base entries plus up to eight task LoRA entries can legitimately\n# exceed the old 64 KiB request cap. Keep the manifest bounded while leaving\n# room for validated immutable source URLs and hashes.\nMAX_MODEL_BODY = 256 * 1024\nMAX_INFERENCE_BODY = 16 * 1024\nMAX_ADDITIONAL_LORAS = 16\nMAX_TASK_LORAS = 8\nMAX_ADDITIONAL_LORA_BYTES = 8 * 1024 * 1024 * 1024\nMAX_SINGLE_LORA_BYTES = 4 * 1024 * 1024 * 1024\nMAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024\nUUID_RE = re.compile(r\"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$\", re.I)\nLORA_ID_RE = re.compile(r\"^(?:builtin-[a-z0-9-]{1,80}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$\", re.I)\nLORA_FILENAME_RE = re.compile(r\"^[^/\\\\\\x00-\\x1f]{1,180}\\.safetensors$\", re.I)\nSHA_RE = re.compile(r\"^[a-f0-9]{64}$\", re.I)\nCOMMIT_RE = re.compile(r\"^[a-f0-9]{40}$\", re.I)\n"],
  ["STATE_LOCK = threading.Lock()\nSTAGE_GATE = threading.Lock()\nSTATE: dict[str, Any] = {\"alive\": True, \"started_at\": None, \"current_stage\": \"idle\", \"current_stage_run_id\": None, \"last_error\": None, \"stages\": {}, \"models\": {}}\nCHILDREN: dict[str, subprocess.Popen[str]] = {}\nCONFIG: dict[str, str] = {}\n", "STATE_LOCK = threading.Lock()\nSTAGE_GATE = threading.Lock()\nSTATE: dict[str, Any] = {\"alive\": True, \"started_at\": None, \"current_stage\": \"idle\", \"current_stage_run_id\": None, \"last_error\": None, \"stages\": {}, \"models\": {}, \"lora_files\": {}}\nCHILDREN: dict[str, subprocess.Popen[str]] = {}\nCONFIG: dict[str, str] = {}\n"],
  ["            except subprocess.TimeoutExpired:\n                process.kill(); exit_code = process.wait(timeout=10)\n    lines = log.read_text(encoding=\"utf-8\", errors=\"replace\").splitlines()\n    patterns = re.compile(r\"ERROR|WARNING: Retrying|ResolutionImpossible|No matching distribution|Could not find|dependency conflict|Requires-Python|Killed|No space left|Traceback|subprocess-exited-with-error|externally-managed-environment\", re.I)\n    return {\"command\": \" \".join(command), \"log_path\": str(log), \"started_at\": started_at, \"finished_at\": now(), \"duration_seconds\": round(time.monotonic() - started, 3), \"exit_code\": exit_code, \"timed_out\": timed_out, \"first_output_lines\": [clean(line, 500) for line in lines[:30]], \"final_output_lines\": [clean(line, 500) for line in lines[-120:]], \"error_matches\": [clean(line, 500) for line in lines if patterns.search(line)]}\n\n\n", "            except subprocess.TimeoutExpired:\n                process.kill(); exit_code = process.wait(timeout=10)\n    patterns = re.compile(r\"ERROR|WARNING: Retrying|ResolutionImpossible|No matching distribution|Could not find|dependency conflict|Requires-Python|Killed|No space left|Traceback|subprocess-exited-with-error|externally-managed-environment\", re.I)\n    first_output_lines: list[str] = []\n    final_output_lines: deque[str] = deque(maxlen=120)\n    error_matches: list[str] = []\n    with log.open(\"r\", encoding=\"utf-8\", errors=\"replace\") as handle:\n        for raw_line in handle:\n            line = clean(raw_line.rstrip(\"\\r\\n\"), 500)\n            if len(first_output_lines) < 30:\n                first_output_lines.append(line)\n            final_output_lines.append(line)\n            if len(error_matches) < 120 and patterns.search(line):\n                error_matches.append(line)\n    return {\"command\": \" \".join(command), \"log_path\": str(log), \"started_at\": started_at, \"finished_at\": now(), \"duration_seconds\": round(time.monotonic() - started, 3), \"exit_code\": exit_code, \"timed_out\": timed_out, \"first_output_lines\": first_output_lines, \"final_output_lines\": list(final_output_lines), \"error_matches\": error_matches}\n\n\n"],
  ["\n\ndef raw_file_url(path: str) -> str:\n    return f\"{RAW_ROOT}/{CONFIG['project_commit']}/{path}\"\n\n\ndef fetch_small_verified(url: str, destination: Path, expected: str) -> None:\n    try:\n        with urllib.request.urlopen(url, timeout=45) as response:\n            if response.status != 200:\n                raise RuntimeError(f\"raw_download_http_{response.status}\")\n            content = response.read(2 * 1024 * 1024)\n    except Exception as error:\n        raise RuntimeError(f\"raw_download_failed:{clean(error, 400)}\") from error\n    destination.parent.mkdir(parents=True, exist_ok=True)\n    destination.write_bytes(content)\n    if sha256(destination) != expected:\n        destination.unlink(missing_ok=True)\n        raise RuntimeError(f\"raw_sha256_mismatch:{destination.name}\")\n\n\ndef project_runtime() -> tuple[Path, dict[str, str]]:\n    runtime = RUNTIME_DIR\n    runtime.mkdir(parents=True, exist_ok=True)\n    controller = runtime / \"controller.py\"\n    workflow = runtime / \"image_workflow.py\"\n    fetch_small_verified(raw_file_url(\"comfy-runtime/controller.py\"), controller, CONFIG[\"controller_sha256\"])\n    fetch_small_verified(raw_file_url(\"comfy-runtime/image_workflow.py\"), workflow, CONFIG[\"workflow_sha256\"])\n    check = exec_fixed([sys.executable, \"-c\", \"import sys;sys.path.insert(0,sys.argv[1]);import image_workflow,controller;print('runtime_import_ok')\", str(runtime)], 45)\n    if check[\"exit_code\"]:\n        raise RuntimeError(\"runtime_import_failed:\" + check[\"output\"])\n    return runtime, {\"project_commit\": CONFIG[\"project_commit\"], \"controller_sha256\": sha256(controller), \"image_workflow_sha256\": sha256(workflow), \"import\": check}\n\n\n", "\n\ndef immutable_file_urls(path: str) -> list[tuple[str, str]]:\n    commit = CONFIG[\"project_commit\"]\n    return [\n        (\"jsdelivr_commit_cdn\", f\"{IMMUTABLE_SOURCE_ROOTS[0][1]}@{commit}/{path}\"),\n        (\"github_raw_commit\", f\"{IMMUTABLE_SOURCE_ROOTS[1][1]}/{commit}/{path}\"),\n    ]\n\n\ndef apply_fixed_source_patches(content: bytes, encoded_patches: str) -> bytes:\n    if not encoded_patches or len(encoded_patches) > 24_000:\n        raise RuntimeError(\"immutable_source_patch_invalid\")\n    try:\n        patches = json.loads(zlib.decompress(base64.b64decode(encoded_patches), -15))\n        text = content.decode(\"utf-8\")\n    except Exception as error:\n        raise RuntimeError(\"immutable_source_patch_invalid\") from error\n    if not isinstance(patches, list) or len(patches) > 16:\n        raise RuntimeError(\"immutable_source_patch_invalid\")\n    for patch in patches:\n        if (\n            not isinstance(patch, list)\n            or len(patch) != 2\n            or not all(isinstance(value, str) for value in patch)\n            or not patch[0]\n            or len(patch[0]) > 100_000\n            or len(patch[1]) > 100_000\n        ):\n            raise RuntimeError(\"immutable_source_patch_invalid\")\n        first = text.find(patch[0])\n        if first < 0 or text.find(patch[0], first + len(patch[0])) >= 0:\n            raise RuntimeError(\"immutable_source_patch_context_mismatch\")\n        text = text[:first] + patch[1] + text[first + len(patch[0]):]\n    return text.encode(\"utf-8\")\n\n\ndef fetch_small_verified(\n    sources: list[tuple[str, str]],\n    destination: Path,\n    source_expected: str,\n    materialized_expected: str | None = None,\n    encoded_patches: str | None = None,\n) -> dict[str, Any]:\n    failures: list[str] = []\n    for source_id, url in sources:\n        try:\n            with urllib.request.urlopen(url, timeout=45) as response:\n                if response.status != 200:\n                    failures.append(f\"{source_id}:http_{response.status}\")\n                    continue\n                content_type = (response.headers.get(\"Content-Type\") or \"\").split(\";\", 1)[0].strip().lower()\n                content = response.read(2 * 1024 * 1024 + 1)\n        except Exception:\n            failures.append(f\"{source_id}:transport_failed\")\n            continue\n        if not content or len(content) > 2 * 1024 * 1024:\n            failures.append(f\"{source_id}:size_invalid\")\n            continue\n        actual = hashlib.sha256(content).hexdigest()\n        if actual != source_expected:\n            raise RuntimeError(f\"immutable_source_sha256_mismatch:{source_id}:{destination.name}\")\n        try:\n            text = content.decode(\"utf-8\")\n            prefix = text.lstrip()[:32].lower()\n            safe_text = \"\\x00\" not in text and not prefix.startswith(\"<!doctype html\") and not prefix.startswith(\"<html\")\n        except UnicodeDecodeError:\n            safe_text = False\n        if content_type not in {\"application/octet-stream\", \"application/x-python\", \"text/plain\", \"text/x-python\"} and not safe_text:\n            failures.append(f\"{source_id}:content_incompatible\")\n            continue\n        materialized = apply_fixed_source_patches(content, encoded_patches) if encoded_patches else content\n        materialized_sha256 = hashlib.sha256(materialized).hexdigest()\n        if materialized_sha256 != (materialized_expected or source_expected):\n            raise RuntimeError(f\"immutable_source_materialized_sha256_mismatch:{source_id}:{destination.name}\")\n        destination.parent.mkdir(parents=True, exist_ok=True)\n        destination.write_bytes(materialized)\n        return {\"endpoint_id\": source_id, \"source_bytes\": len(content), \"source_sha256\": actual, \"bytes\": len(materialized), \"sha256\": materialized_sha256, \"patched\": bool(encoded_patches)}\n    raise RuntimeError(\"immutable_source_unavailable:\" + \",\".join(failures))\n\n\ndef project_runtime() -> tuple[Path, dict[str, str]]:\n    runtime = RUNTIME_DIR\n    runtime.mkdir(parents=True, exist_ok=True)\n    controller = runtime / \"controller.py\"\n    workflow = runtime / \"image_workflow.py\"\n    controller_source = fetch_small_verified(\n        immutable_file_urls(\"comfy-runtime/controller.py\"),\n        controller,\n        CONFIG[\"controller_source_sha256\"],\n        CONFIG[\"controller_sha256\"],\n        CONFIG[\"controller_patch\"],\n    )\n    workflow_source = fetch_small_verified(\n        immutable_file_urls(\"comfy-runtime/image_workflow.py\"),\n        workflow,\n        CONFIG[\"workflow_source_sha256\"],\n        CONFIG[\"workflow_sha256\"],\n        CONFIG[\"workflow_patch\"],\n    )\n    check = exec_fixed([sys.executable, \"-c\", \"import sys;sys.path.insert(0,sys.argv[1]);import image_workflow,controller;print('runtime_import_ok')\", str(runtime)], 45)\n    if check[\"exit_code\"]:\n        raise RuntimeError(\"runtime_import_failed:\" + check[\"output\"])\n    return runtime, {\"project_commit\": CONFIG[\"project_commit\"], \"controller_sha256\": sha256(controller), \"image_workflow_sha256\": sha256(workflow), \"controller_source\": controller_source, \"workflow_source\": workflow_source, \"import\": check}\n\n\n"],
  ["def validate_manifest(payload: object) -> list[dict[str, Any]]:\n    entries = payload.get(\"models\") if isinstance(payload, dict) else None\n    if not isinstance(entries, list) or len(entries) != len(APPROVED_MODELS):\n        raise ValueError(\"exactly_five_models_required\")\n    result: list[dict[str, Any]] = []\n", "def validate_manifest(payload: object) -> list[dict[str, Any]]:\n    entries = payload.get(\"models\") if isinstance(payload, dict) else None\n    if (\n        not isinstance(payload, dict)\n        or not set(payload).issubset({\"models\", \"loras\"})\n        or not isinstance(entries, list)\n        or len(entries) != len(APPROVED_MODELS)\n    ):\n        raise ValueError(\"exactly_five_models_required\")\n    result: list[dict[str, Any]] = []\n"],
  ["        if not isinstance(digest, str) or not SHA_RE.fullmatch(digest) or not isinstance(size, int) or size <= 0:\n            raise ValueError(\"invalid_model_hash_or_size\")\n        result.append({\"role\": role, \"filename\": filename, \"url\": safe_download_url(entry[\"url\"]), \"sha256\": digest.lower(), \"size_bytes\": size, \"destination\": str(COMFY_DIR / \"models\" / expected[1] / filename)})\n        seen_roles.add(role); seen_names.add(filename)\n    if seen_roles != set(APPROVED_MODELS):\n        raise ValueError(\"missing_approved_model_role\")\n    return result\n\n\ndef stream_model(entry: dict[str, Any]) -> dict[str, Any]:\n    destination = Path(entry[\"destination\"]); part = destination.with_name(destination.name + \".part\")\n    destination.parent.mkdir(parents=True, exist_ok=True)\n    if destination.is_file() and destination.stat().st_size == entry[\"size_bytes\"] and sha256(destination) == entry[\"sha256\"]:\n        return {\"filename\": entry[\"filename\"], \"status\": \"verified_existing\", \"downloaded_bytes\": entry[\"size_bytes\"], \"size_bytes\": entry[\"size_bytes\"], \"sha256\": entry[\"sha256\"]}\n    expected = entry[\"size_bytes\"]; attempts = 0; restarted = False; last: dict[str, Any] = {\"http_status\": None, \"content_length\": None, \"content_range\": None, \"hostname\": urllib.parse.urlsplit(entry[\"url\"]).hostname or \"\", \"error\": None}\n    last_progress = -64 * 1024 * 1024; last_write = 0.0\n    def state(status: str, offset: int, force: bool = False) -> None:\n        nonlocal last_progress, last_write\n        moment = time.monotonic()\n        if not force and offset - last_progress < 64 * 1024 * 1024 and moment - last_write < 5: return\n        with STATE_LOCK:\n            STATE[\"models\"][entry[\"role\"]] = {\"filename\": entry[\"filename\"], \"status\": status, \"downloaded_bytes\": offset, \"size_bytes\": expected, \"attempt\": attempts, \"url\": redacted_url(entry[\"url\"])}; save_locked()\n        last_progress, last_write = offset, moment\n    def download_request(resume_offset: int) -> urllib.request.Request:\n", "        if not isinstance(digest, str) or not SHA_RE.fullmatch(digest) or not isinstance(size, int) or size <= 0:\n            raise ValueError(\"invalid_model_hash_or_size\")\n        result.append({\"kind\": \"base\", \"role\": role, \"state_bucket\": \"models\", \"state_key\": role, \"filename\": filename, \"url\": safe_download_url(entry[\"url\"]), \"sha256\": digest.lower(), \"size_bytes\": size, \"destination\": str(COMFY_DIR / \"models\" / expected[1] / filename)})\n        seen_roles.add(role); seen_names.add(filename)\n    if seen_roles != set(APPROVED_MODELS):\n        raise ValueError(\"missing_approved_model_role\")\n    loras = payload.get(\"loras\", [])\n    if not isinstance(loras, list) or len(loras) > MAX_ADDITIONAL_LORAS:\n        raise ValueError(\"too_many_additional_loras\")\n    seen_lora_ids: set[str] = set(); additional_bytes = 0\n    for entry in loras:\n        if not isinstance(entry, dict) or set(entry) != {\"id\", \"filename\", \"url\", \"sha256\", \"size_bytes\"}:\n            raise ValueError(\"invalid_additional_lora_fields\")\n        lora_id = entry[\"id\"]; filename = entry[\"filename\"]; digest = entry[\"sha256\"]; size = entry[\"size_bytes\"]\n        if not isinstance(lora_id, str) or not LORA_ID_RE.fullmatch(lora_id) or lora_id in seen_lora_ids:\n            raise ValueError(\"invalid_or_duplicate_lora_id\")\n        if not isinstance(filename, str) or not LORA_FILENAME_RE.fullmatch(filename) or filename.lower() in {name.lower() for name in seen_names}:\n            raise ValueError(\"invalid_or_duplicate_lora_filename\")\n        if not isinstance(digest, str) or not SHA_RE.fullmatch(digest) or not isinstance(size, int) or size < 1024 or size > MAX_SINGLE_LORA_BYTES:\n            raise ValueError(\"invalid_lora_hash_or_size\")\n        additional_bytes += size\n        if additional_bytes > MAX_ADDITIONAL_LORA_BYTES:\n            raise ValueError(\"additional_loras_too_large\")\n        result.append({\n            \"kind\": \"additional_lora\",\n            \"role\": f\"lora:{lora_id}\",\n            \"state_bucket\": \"lora_files\",\n            \"state_key\": filename,\n            \"lora_id\": lora_id,\n            \"filename\": filename,\n            \"url\": safe_download_url(entry[\"url\"]),\n            \"sha256\": digest.lower(),\n            \"size_bytes\": size,\n            \"destination\": str(COMFY_DIR / \"models\" / \"loras\" / filename),\n        })\n        seen_lora_ids.add(lora_id); seen_names.add(filename)\n    return result\n\n\ndef stream_model(entry: dict[str, Any]) -> dict[str, Any]:\n    destination = Path(entry[\"destination\"]); part = destination.with_name(destination.name + \".part\")\n    destination.parent.mkdir(parents=True, exist_ok=True)\n    if destination.is_file() and destination.stat().st_size == entry[\"size_bytes\"] and sha256(destination) == entry[\"sha256\"]:\n        if entry[\"kind\"] == \"additional_lora\":\n            try:\n                validate_safetensors_file(destination)\n            except StageFailure:\n                # A corrupt destination must not poison every later retry.\n                destination.unlink(missing_ok=True)\n            else:\n                return {\"filename\": entry[\"filename\"], \"status\": \"verified_existing\", \"downloaded_bytes\": entry[\"size_bytes\"], \"size_bytes\": entry[\"size_bytes\"], \"sha256\": entry[\"sha256\"]}\n        else:\n            return {\"filename\": entry[\"filename\"], \"status\": \"verified_existing\", \"downloaded_bytes\": entry[\"size_bytes\"], \"size_bytes\": entry[\"size_bytes\"], \"sha256\": entry[\"sha256\"]}\n    expected = entry[\"size_bytes\"]; attempts = 0; restarted = False; last: dict[str, Any] = {\"http_status\": None, \"content_length\": None, \"content_range\": None, \"hostname\": urllib.parse.urlsplit(entry[\"url\"]).hostname or \"\", \"error\": None}\n    last_progress = -64 * 1024 * 1024; last_write = 0.0\n    def state(status: str, offset: int, force: bool = False) -> None:\n        nonlocal last_progress, last_write\n        moment = time.monotonic()\n        if not force and offset - last_progress < 64 * 1024 * 1024 and moment - last_write < 5: return\n        with STATE_LOCK:\n            bucket = STATE.setdefault(entry[\"state_bucket\"], {})\n            bucket[entry[\"state_key\"]] = {\"filename\": entry[\"filename\"], \"status\": status, \"downloaded_bytes\": offset, \"size_bytes\": expected, \"attempt\": attempts, \"url\": redacted_url(entry[\"url\"])}; save_locked()\n        last_progress, last_write = offset, moment\n    def download_request(resume_offset: int) -> urllib.request.Request:\n"],
  ["            state(\"verifying\", offset, True)\n            actual = sha256(part)\n            if actual != entry[\"sha256\"]: raise StageFailure(f\"model_sha256_mismatch:{entry['filename']}\", {\"code\": \"model_sha256_mismatch\", \"role\": entry[\"role\"], \"filename\": entry[\"filename\"], \"expected_sha256\": entry[\"sha256\"], \"actual_sha256\": actual, \"byte_size\": offset})\n            os.replace(part, destination); state(\"verified\", offset, True)\n            return {\"filename\": entry[\"filename\"], \"status\": \"verified\", \"downloaded_bytes\": expected, \"size_bytes\": expected, \"sha256\": entry[\"sha256\"]}\n", "            state(\"verifying\", offset, True)\n            actual = sha256(part)\n            if actual != entry[\"sha256\"]:\n                part.unlink(missing_ok=True)\n                state(\"corrupt_discarded\", 0, True)\n                raise StageFailure(f\"model_sha256_mismatch:{entry['filename']}\", {\"code\": \"model_sha256_mismatch\", \"role\": entry[\"role\"], \"filename\": entry[\"filename\"], \"expected_sha256\": entry[\"sha256\"], \"actual_sha256\": actual, \"byte_size\": offset, \"discarded_partial\": True})\n            if entry[\"kind\"] == \"additional_lora\":\n                try:\n                    validate_safetensors_file(part)\n                except StageFailure as error:\n                    part.unlink(missing_ok=True)\n                    state(\"corrupt_discarded\", 0, True)\n                    if isinstance(error, StageFailure):\n                        error.data[\"discarded_partial\"] = True\n                    raise\n            os.replace(part, destination); state(\"verified\", offset, True)\n            return {\"filename\": entry[\"filename\"], \"status\": \"verified\", \"downloaded_bytes\": expected, \"size_bytes\": expected, \"sha256\": entry[\"sha256\"]}\n"],
  ["\n\ndef stage_models(payload: dict[str, Any]) -> dict[str, Any]:\n    manifest = validate_manifest(payload)\n    results: dict[str, Any] = {}\n    for entry in manifest:\n        with STATE_LOCK:\n            STATE[\"models\"][entry[\"role\"]] = {\"filename\": entry[\"filename\"], \"status\": \"queued\", \"downloaded_bytes\": 0, \"size_bytes\": entry[\"size_bytes\"], \"url\": redacted_url(entry[\"url\"])}\n            save_locked()\n        result = stream_model(entry)\n        results[entry[\"role\"]] = result\n        with STATE_LOCK:\n            STATE[\"models\"][entry[\"role\"]] = result\n            save_locked()\n    return {\"models\": results}\n\n\n", "\n\ndef validate_safetensors_file(path: Path) -> dict[str, int]:\n    \"\"\"Validate the bounded structural header before a dynamic LoRA is installed.\"\"\"\n    size = path.stat().st_size\n    if size < 10:\n        raise StageFailure(\"invalid_lora_safetensors\", {\"code\": \"invalid_lora_safetensors\", \"filename\": path.name, \"reason\": \"file_too_small\", \"byte_size\": size})\n    with path.open(\"rb\") as handle:\n        raw_length = handle.read(8)\n        header_length = int.from_bytes(raw_length, \"little\")\n        if header_length < 2 or header_length > MAX_SAFETENSORS_HEADER_BYTES or header_length + 8 > size:\n            raise StageFailure(\"invalid_lora_safetensors\", {\"code\": \"invalid_lora_safetensors\", \"filename\": path.name, \"reason\": \"invalid_header_length\", \"byte_size\": size, \"header_bytes\": header_length})\n        raw_header = handle.read(header_length)\n    try:\n        header = json.loads(raw_header.decode(\"utf-8\"))\n    except (UnicodeDecodeError, json.JSONDecodeError) as error:\n        raise StageFailure(\"invalid_lora_safetensors\", {\"code\": \"invalid_lora_safetensors\", \"filename\": path.name, \"reason\": \"invalid_header_json\", \"byte_size\": size}) from error\n    if not isinstance(header, dict):\n        raise StageFailure(\"invalid_lora_safetensors\", {\"code\": \"invalid_lora_safetensors\", \"filename\": path.name, \"reason\": \"invalid_header_shape\", \"byte_size\": size})\n    tensor_count = 0\n    data_bytes = size - 8 - header_length\n    for name, descriptor in header.items():\n        if name == \"__metadata__\":\n            if not isinstance(descriptor, dict):\n                raise StageFailure(\"invalid_lora_safetensors\", {\"code\": \"invalid_lora_safetensors\", \"filename\": path.name, \"reason\": \"invalid_metadata\"})\n            continue\n        if (\n            not isinstance(name, str)\n            or not isinstance(descriptor, dict)\n            or not isinstance(descriptor.get(\"dtype\"), str)\n            or not isinstance(descriptor.get(\"shape\"), list)\n            or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in descriptor[\"shape\"])\n            or not isinstance(descriptor.get(\"data_offsets\"), list)\n            or len(descriptor[\"data_offsets\"]) != 2\n            or any(not isinstance(value, int) or isinstance(value, bool) for value in descriptor[\"data_offsets\"])\n            or descriptor[\"data_offsets\"][0] < 0\n            or descriptor[\"data_offsets\"][0] > descriptor[\"data_offsets\"][1]\n            or descriptor[\"data_offsets\"][1] > data_bytes\n        ):\n            raise StageFailure(\"invalid_lora_safetensors\", {\"code\": \"invalid_lora_safetensors\", \"filename\": path.name, \"reason\": \"invalid_tensor_descriptor\"})\n        tensor_count += 1\n    if tensor_count == 0:\n        raise StageFailure(\"invalid_lora_safetensors\", {\"code\": \"invalid_lora_safetensors\", \"filename\": path.name, \"reason\": \"no_tensors\"})\n    return {\"header_bytes\": header_length, \"tensor_count\": tensor_count}\n\n\ndef stage_models(payload: dict[str, Any]) -> dict[str, Any]:\n    manifest = validate_manifest(payload)\n    model_results: dict[str, Any] = {}\n    lora_results: dict[str, Any] = {}\n    with STATE_LOCK:\n        STATE[\"lora_files\"] = {}\n        save_locked()\n    for entry in manifest:\n        with STATE_LOCK:\n            bucket = STATE.setdefault(entry[\"state_bucket\"], {})\n            bucket[entry[\"state_key\"]] = {\"filename\": entry[\"filename\"], \"status\": \"queued\", \"downloaded_bytes\": 0, \"size_bytes\": entry[\"size_bytes\"], \"url\": redacted_url(entry[\"url\"])}\n            save_locked()\n        result = stream_model(entry)\n        with STATE_LOCK:\n            STATE[entry[\"state_bucket\"]][entry[\"state_key\"]] = result\n            save_locked()\n        if entry[\"kind\"] == \"base\":\n            model_results[entry[\"role\"]] = result\n        else:\n            lora_results[entry[\"lora_id\"]] = result\n    return {\"models\": model_results, \"loras\": lora_results}\n\n\n"],
  ["    task_id = validate_inference_shape(payload)\n    with STATE_LOCK:\n        verified_roles = {role for role, value in STATE[\"models\"].items() if value.get(\"status\") in {\"verified\", \"verified_existing\"}}\n    if verified_roles != set(APPROVED_MODELS):\n        raise RuntimeError(\"models_not_verified\")\n    controller_status, controller_health = request_json(\"http://127.0.0.1:18080/healthz\")\n    comfy_status, _ = request_json(\"http://127.0.0.1:8188/system_stats\")\n", "    task_id = validate_inference_shape(payload)\n    with STATE_LOCK:\n        verified_roles = {role for role, value in STATE.get(\"models\", {}).items() if value.get(\"status\") in {\"verified\", \"verified_existing\"}}\n        verified_lora_files = {filename for filename, value in STATE.get(\"lora_files\", {}).items() if value.get(\"status\") in {\"verified\", \"verified_existing\"}}\n    if verified_roles != set(APPROVED_MODELS):\n        raise RuntimeError(\"models_not_verified\")\n    requested_loras = payload.get(\"loras\")\n    if requested_loras is None:\n        requested_lora_filenames = {APPROVED_MODELS[\"lora\"][0]}\n    else:\n        requested_lora_filenames = {entry[\"filename\"] for entry in requested_loras}\n    builtin_lora = APPROVED_MODELS[\"lora\"][0]\n    missing_loras = sorted(filename for filename in requested_lora_filenames if filename != builtin_lora and filename not in verified_lora_files)\n    if missing_loras:\n        raise StageFailure(\"requested_loras_not_verified\", {\"code\": \"requested_loras_not_verified\", \"filenames\": missing_loras})\n    controller_status, controller_health = request_json(\"http://127.0.0.1:18080/healthz\")\n    comfy_status, _ = request_json(\"http://127.0.0.1:8188/system_stats\")\n"],
  ["    artifact.mkdir(parents=True, exist_ok=True)\n    image_path = artifact / \"image.png\"; image_path.write_bytes(image)\n    metadata = {\"task_id\": task_id, \"width\": width, \"height\": height, \"byte_size\": len(image), \"sha256\": sha256(image_path), \"generation_duration_seconds\": round(time.monotonic() - started, 3), \"controller_job_id\": job_id, \"controller_prompt_id\": job.get(\"prompt_id\")}\n    (artifact / \"metadata.json\").write_text(json.dumps(metadata, indent=2), encoding=\"utf-8\")\n    return metadata\n\n\ndef validate_inference_shape(payload: object) -> str:\n    if not isinstance(payload, dict) or set(payload) != {\"task_id\", \"mode\", \"prompt\", \"width\", \"height\", \"steps\", \"cfg\", \"lora_strength\", \"seed\", \"sampler\"}:\n        raise ValueError(\"invalid_inference_fields\")\n    task_id = payload.get(\"task_id\")\n    if not isinstance(task_id, str) or not UUID_RE.fullmatch(task_id):\n        raise ValueError(\"invalid_task_id\")\n    if payload.get(\"mode\") != \"text_generation\" or not isinstance(payload.get(\"prompt\"), str) or len(payload[\"prompt\"]) > 4000:\n        raise ValueError(\"invalid_inference_request\")\n    return task_id\n\n", "    artifact.mkdir(parents=True, exist_ok=True)\n    image_path = artifact / \"image.png\"; image_path.write_bytes(image)\n    metadata = {\"task_id\": task_id, \"width\": width, \"height\": height, \"byte_size\": len(image), \"sha256\": sha256(image_path), \"generation_duration_seconds\": round(time.monotonic() - started, 3), \"controller_job_id\": job_id, \"controller_prompt_id\": job.get(\"prompt_id\"), \"negative_prompt_present\": bool(payload.get(\"negative_prompt\")), \"loras\": [{\"filename\": entry[\"filename\"], \"strength\": entry[\"strength\"]} for entry in payload.get(\"loras\", [{\"filename\": builtin_lora, \"strength\": payload[\"lora_strength\"]}])]}\n    (artifact / \"metadata.json\").write_text(json.dumps(metadata, indent=2), encoding=\"utf-8\")\n    return metadata\n\n\ndef validate_inference_shape(payload: object) -> str:\n    required = {\"task_id\", \"mode\", \"prompt\", \"width\", \"height\", \"steps\", \"cfg\", \"lora_strength\", \"seed\", \"sampler\"}\n    if not isinstance(payload, dict) or not required.issubset(payload) or not set(payload).issubset(required | {\"negative_prompt\", \"loras\"}):\n        raise ValueError(\"invalid_inference_fields\")\n    task_id = payload.get(\"task_id\")\n    if not isinstance(task_id, str) or not UUID_RE.fullmatch(task_id):\n        raise ValueError(\"invalid_task_id\")\n    if payload.get(\"mode\") != \"text_generation\" or not isinstance(payload.get(\"prompt\"), str) or len(payload[\"prompt\"]) > 4000:\n        raise ValueError(\"invalid_inference_request\")\n    negative_prompt = payload.get(\"negative_prompt\", \"\")\n    if not isinstance(negative_prompt, str) or len(negative_prompt) > 4000:\n        raise ValueError(\"invalid_negative_prompt\")\n    loras = payload.get(\"loras\")\n    if loras is not None:\n        if not isinstance(loras, list) or len(loras) > MAX_TASK_LORAS:\n            raise ValueError(\"invalid_inference_loras\")\n        seen: set[str] = set()\n        for entry in loras:\n            if not isinstance(entry, dict) or set(entry) != {\"filename\", \"strength\"}:\n                raise ValueError(\"invalid_inference_lora_fields\")\n            filename = entry.get(\"filename\"); strength = entry.get(\"strength\")\n            if (\n                not isinstance(filename, str)\n                or not LORA_FILENAME_RE.fullmatch(filename)\n                or filename.lower() in seen\n                or not isinstance(strength, (int, float))\n                or isinstance(strength, bool)\n                or not 0 <= float(strength) <= 1.5\n            ):\n                raise ValueError(\"invalid_inference_lora\")\n            seen.add(filename.lower())\n    return task_id\n\n"],
  ["\n\ndef run_stage(route: str, payload: dict[str, Any]) -> str | None:\n    name, action, _ = STAGES[route]\n    if not STAGE_GATE.acquire(blocking=False):\n        return None\n    stage_run_id = str(uuid.uuid4())\n    try:\n        # Persist the accepted invocation before exposing HTTP 202.  This is a\n", "\n\ndef run_stage(route: str, payload: dict[str, Any], stage_run_id: str) -> str | None:\n    name, action, _ = STAGES[route]\n    if not STAGE_GATE.acquire(blocking=False):\n        return None\n    try:\n        # Persist the accepted invocation before exposing HTTP 202.  This is a\n"],
  ["        route = urllib.parse.urlsplit(self.path).path\n        if route == \"/healthz\":\n            with STATE_LOCK: value = {\"alive\": True, \"agent\": \"restricted-clore-diagnostic\", \"current_stage\": STATE[\"current_stage\"], \"current_stage_run_id\": STATE.get(\"current_stage_run_id\"), \"last_error\": STATE[\"last_error\"]}\n            self.send_json(200, value); return\n        if route in {\"/status\", \"/logs\"}:\n", "        route = urllib.parse.urlsplit(self.path).path\n        if route == \"/healthz\":\n            with STATE_LOCK: value = {\"alive\": True, \"agent\": \"restricted-clore-diagnostic\", \"agent_contract\": \"stage-acceptance-v2\", \"agent_sha256\": sha256(Path(__file__)), \"current_stage\": STATE[\"current_stage\"], \"current_stage_run_id\": STATE.get(\"current_stage_run_id\"), \"last_error\": STATE[\"last_error\"]}\n            self.send_json(200, value); return\n        if route in {\"/status\", \"/logs\"}:\n"],
  ["        try: length = int(self.headers.get(\"Content-Length\", \"0\"))\n        except ValueError: self.send_json(400, {\"error\": \"invalid_content_length\"}); return\n        if length < 0 or length > limit: self.send_json(413, {\"error\": \"stage_body_too_large\"}); return\n        raw = self.rfile.read(length) if length else b\"\"\n        if limit == 0 and raw: self.send_json(400, {\"error\": \"stage_parameters_forbidden\"}); return\n        try: payload = json.loads(raw.decode(\"utf-8\")) if raw else {}\n        except Exception: self.send_json(400, {\"error\": \"invalid_json\"}); return\n        if not isinstance(payload, dict): self.send_json(400, {\"error\": \"invalid_stage_payload\"}); return\n        try:\n            if route == \"/stage/models\": validate_manifest(payload)\n            if route == \"/stage/inference\": validate_inference_shape(payload)\n        except ValueError as error:\n            self.send_json(400, {\"error\": str(error)}); return\n        stage_run_id = run_stage(route, payload)\n        if not stage_run_id: self.send_json(409, {\"error\": \"stage_already_running\"}); return\n        self.send_json(202, {\"accepted\": True, \"stage\": item[0], \"stage_run_id\": stage_run_id})\n\n\ndef main() -> None:\n    parser = argparse.ArgumentParser()\n    parser.add_argument(\"--token-sha256\", required=True)\n    parser.add_argument(\"--project-commit\")\n    parser.add_argument(\"--controller-sha256\")\n    parser.add_argument(\"--workflow-sha256\")\n    parser.add_argument(\"--immutable\", help=\"commit:controller_sha256:workflow_sha256\")\n    parser.add_argument(\"--port\", type=int, default=8080)\n    args = parser.parse_args()\n    if args.immutable:\n        parts = args.immutable.split(\":\")\n        if len(parts) != 3:\n            raise SystemExit(\"immutable_sha256_and_project_commit_required\")\n        args.project_commit, args.controller_sha256, args.workflow_sha256 = parts\n    if not args.project_commit or not args.controller_sha256 or not args.workflow_sha256 or not COMMIT_RE.fullmatch(args.project_commit) or not SHA_RE.fullmatch(args.controller_sha256) or not SHA_RE.fullmatch(args.workflow_sha256) or not SHA_RE.fullmatch(args.token_sha256):\n        raise SystemExit(\"immutable_sha256_and_project_commit_required\")\n    CONFIG.update({\"project_commit\": args.project_commit.lower(), \"controller_sha256\": args.controller_sha256.lower(), \"workflow_sha256\": args.workflow_sha256.lower()})\n    ROOT.mkdir(parents=True, exist_ok=True); LOG_DIR.mkdir(parents=True, exist_ok=True)\n    with STATE_LOCK:\n", "        try: length = int(self.headers.get(\"Content-Length\", \"0\"))\n        except ValueError: self.send_json(400, {\"error\": \"invalid_content_length\"}); return\n        if length < 0 or (limit > 0 and length > limit) or (limit == 0 and length > 128): self.send_json(413, {\"error\": \"stage_body_too_large\"}); return\n        raw = self.rfile.read(length) if length else b\"\"\n        try: payload = json.loads(raw.decode(\"utf-8\")) if raw else {}\n        except Exception: self.send_json(400, {\"error\": \"invalid_json\"}); return\n        if not isinstance(payload, dict): self.send_json(400, {\"error\": \"invalid_stage_payload\"}); return\n        stage_run_id = payload.pop(\"stage_run_id\", None)\n        if not isinstance(stage_run_id, str) or not UUID_RE.fullmatch(stage_run_id): self.send_json(400, {\"error\": \"stage_run_id_required\"}); return\n        if limit == 0 and payload: self.send_json(400, {\"error\": \"stage_parameters_forbidden\"}); return\n        try:\n            if route == \"/stage/models\": validate_manifest(payload)\n            if route == \"/stage/inference\": validate_inference_shape(payload)\n        except ValueError as error:\n            self.send_json(400, {\"error\": str(error)}); return\n        stage_run_id = run_stage(route, payload, stage_run_id)\n        if not stage_run_id: self.send_json(409, {\"error\": \"stage_already_running\"}); return\n        self.send_json(202, {\"accepted\": True, \"state\": \"accepted\", \"status\": \"running\", \"stage\": item[0], \"stage_run_id\": stage_run_id})\n\n\ndef main() -> None:\n    parser = argparse.ArgumentParser()\n    parser.add_argument(\"--token-sha256\", required=True)\n    parser.add_argument(\"--project-commit\")\n    parser.add_argument(\"--controller-sha256\")\n    parser.add_argument(\"--controller-source-sha256\")\n    parser.add_argument(\"--controller-patch\")\n    parser.add_argument(\"--workflow-sha256\")\n    parser.add_argument(\"--workflow-source-sha256\")\n    parser.add_argument(\"--workflow-patch\")\n    parser.add_argument(\"--immutable\", help=\"commit:controller_sha256:workflow_sha256\")\n    parser.add_argument(\"--port\", type=int, default=8080)\n    args = parser.parse_args()\n    if args.immutable:\n        parts = args.immutable.split(\":\")\n        if len(parts) != 3:\n            raise SystemExit(\"immutable_sha256_and_project_commit_required\")\n        args.project_commit, args.controller_sha256, args.workflow_sha256 = parts\n    if not args.project_commit or not args.controller_sha256 or not args.controller_source_sha256 or not args.controller_patch or not args.workflow_sha256 or not args.workflow_source_sha256 or not args.workflow_patch or not COMMIT_RE.fullmatch(args.project_commit) or not SHA_RE.fullmatch(args.controller_sha256) or not SHA_RE.fullmatch(args.controller_source_sha256) or not SHA_RE.fullmatch(args.workflow_sha256) or not SHA_RE.fullmatch(args.workflow_source_sha256) or not SHA_RE.fullmatch(args.token_sha256):\n        raise SystemExit(\"immutable_sha256_and_project_commit_required\")\n    CONFIG.update({\"project_commit\": args.project_commit.lower(), \"controller_source_sha256\": args.controller_source_sha256.lower(), \"controller_sha256\": args.controller_sha256.lower(), \"controller_patch\": args.controller_patch, \"workflow_source_sha256\": args.workflow_source_sha256.lower(), \"workflow_sha256\": args.workflow_sha256.lower(), \"workflow_patch\": args.workflow_patch})\n    ROOT.mkdir(parents=True, exist_ok=True); LOG_DIR.mkdir(parents=True, exist_ok=True)\n    with STATE_LOCK:\n"],
] as const;

export const RTX4090_GOLDEN_CONTROLLER_SOURCE_PATCHES = [
  [
    String.raw`                    assert_node_classes(json_payload(response))`,
    String.raw`                    assert_node_classes(json_payload(response), require_lora=bool(options["loras"]))`,
  ],
] as const;

/**
 * The public commit is an immutable delivery anchor. These exact,
 * one-context replacements deterministically materialize the current workflow
 * without ever falling back to a mutable branch.
 */
export const RTX4090_GOLDEN_WORKFLOW_SOURCE_PATCHES = [
  [
    String.raw`"""Validated ComfyUI API graph for the single supported FLUX text path."""
from __future__ import annotations

import json
from typing import Any

REQUIRED_NODE_CLASSES = {
    "CLIPTextEncode", "DualCLIPLoader", "EmptySD3LatentImage", "FluxGuidance",
    "KSampler", "LoraLoader", "SaveImage", "UNETLoader", "VAEDecode", "VAELoader",
}

FLUXED_UP = "fluxedUpFluxNSFW_102BF16.safetensors"
AIDMA = "aidmaNSFWunlock-FLUX-V0.2.safetensors"
VAE = "ae.safetensors"
CLIP_L = "clip_l.safetensors"
T5 = "t5xxl_fp8_e4m3fn_scaled.safetensors"`,
    String.raw`"""Validated ComfyUI API graph for the supported FLUX text path."""
from __future__ import annotations

import json
import re
from typing import Any

REQUIRED_NODE_CLASSES = {
    "CLIPTextEncode", "DualCLIPLoader", "EmptySD3LatentImage", "FluxGuidance",
    "KSampler", "LoraLoader", "SaveImage", "UNETLoader", "VAEDecode", "VAELoader",
}

FLUXED_UP = "fluxedUpFluxNSFW_102BF16.safetensors"
AIDMA = "aidmaNSFWunlock-FLUX-V0.2.safetensors"
VAE = "ae.safetensors"
CLIP_L = "clip_l.safetensors"
T5 = "t5xxl_fp8_e4m3fn_scaled.safetensors"
SAFE_LORA_FILENAME = re.compile(r"^[^/\\\x00-\x1f]{1,180}\.safetensors$", re.I)
MAX_LORAS = 8`,
  ],
  [
    String.raw`def validate_request(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("invalid_image_generation_request")
    if payload.get("mode") != "text_generation":
        raise ValueError("unsupported_image_mode")
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt or len(prompt) > 4000:
        raise ValueError("invalid_prompt")
    width, height = int(payload.get("width", 0)), int(payload.get("height", 0))
    steps, cfg, strength = int(payload.get("steps", 0)), float(payload.get("cfg", 0)), float(payload.get("lora_strength", 0))
    seed = int(payload.get("seed", -1)); sampler = str(payload.get("sampler", ""))
    if width < 768 or height < 768 or width > 1280 or height > 1280 or width % 256 or height % 256:
        raise ValueError("rtx4090_resolution_required")
    if steps < 25 or steps > 40 or cfg < 3.5 or cfg > 5.0 or strength < 0.6 or strength > 1.1:
        raise ValueError("invalid_text_generation_settings")
    if seed < 0 or seed > 2_147_483_647 or sampler not in {"Euler", "FlowMatch"}:
        raise ValueError("invalid_sampler_or_seed")
    return {"prompt": prompt, "width": width, "height": height, "steps": steps, "cfg": cfg, "lora_strength": strength, "seed": seed, "sampler": sampler}`,
    String.raw`def validate_request(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("invalid_image_generation_request")
    if payload.get("mode") != "text_generation":
        raise ValueError("unsupported_image_mode")
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt or len(prompt) > 4000:
        raise ValueError("invalid_prompt")
    negative_prompt = payload.get("negative_prompt", "")
    if not isinstance(negative_prompt, str) or len(negative_prompt) > 4000:
        raise ValueError("invalid_negative_prompt")
    width, height = int(payload.get("width", 0)), int(payload.get("height", 0))
    steps, cfg, strength = int(payload.get("steps", 0)), float(payload.get("cfg", 0)), float(payload.get("lora_strength", 0))
    seed = int(payload.get("seed", -1)); sampler = str(payload.get("sampler", ""))
    if width < 768 or height < 768 or width > 1536 or height > 1536 or width % 256 or height % 256:
        raise ValueError("unsupported_text_generation_resolution")
    if steps < 25 or steps > 40 or cfg < 3.5 or cfg > 5.0 or strength < 0.6 or strength > 1.1:
        raise ValueError("invalid_text_generation_settings")
    if seed < 0 or seed > 2_147_483_647 or sampler not in {"Euler", "FlowMatch"}:
        raise ValueError("invalid_sampler_or_seed")
    raw_loras = payload.get("loras")
    if raw_loras is None:
        # Backward compatibility: old tasks had only the fixed AIDMA strength.
        loras = [{"filename": AIDMA, "strength": strength}]
    else:
        if not isinstance(raw_loras, list) or len(raw_loras) > MAX_LORAS:
            raise ValueError("invalid_loras")
        loras = []
        seen: set[str] = set()
        for item in raw_loras:
            if not isinstance(item, dict) or set(item) != {"filename", "strength"}:
                raise ValueError("invalid_lora_fields")
            filename = item.get("filename")
            item_strength = item.get("strength")
            if (
                not isinstance(filename, str)
                or not SAFE_LORA_FILENAME.fullmatch(filename)
                or filename.lower() in seen
                or isinstance(item_strength, bool)
                or not isinstance(item_strength, (int, float))
                or not 0.0 <= float(item_strength) <= 1.5
            ):
                raise ValueError("invalid_lora")
            seen.add(filename.lower())
            loras.append({"filename": filename, "strength": float(item_strength)})
    return {
        "prompt": prompt,
        "negative_prompt": negative_prompt.strip(),
        "loras": loras,
        "width": width,
        "height": height,
        "steps": steps,
        "cfg": cfg,
        "lora_strength": strength,
        "seed": seed,
        "sampler": sampler,
    }`,
  ],
  [
    String.raw`def build_text_workflow(job_id: str, options: dict[str, Any]) -> dict[str, Any]:
    # FlowMatch is represented explicitly in metadata and uses the FLUX Euler/simple sampler pair.
    sampler_name = "euler" if options["sampler"] in {"Euler", "FlowMatch"} else "euler"
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": FLUXED_UP, "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": CLIP_L, "clip_name2": T5, "type": "flux"}},
        "3": {"class_type": "LoraLoader", "inputs": {"model": ["1", 0], "clip": ["2", 0], "lora_name": AIDMA, "strength_model": options["lora_strength"], "strength_clip": options["lora_strength"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": options["prompt"], "clip": ["3", 1]}},
        "5": {"class_type": "FluxGuidance", "inputs": {"conditioning": ["4", 0], "guidance": options["cfg"]}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": options["width"], "height": options["height"], "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["3", 0], "seed": options["seed"], "steps": options["steps"], "cfg": 1.0, "sampler_name": sampler_name, "scheduler": "simple", "positive": ["5", 0], "negative": ["5", 0], "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["8", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"image-{job_id}", "images": ["9", 0]}},
    }`,
    String.raw`def build_text_workflow(job_id: str, options: dict[str, Any]) -> dict[str, Any]:
    # FlowMatch is represented explicitly in metadata and uses the FLUX Euler/simple sampler pair.
    sampler_name = "euler" if options["sampler"] in {"Euler", "FlowMatch"} else "euler"
    graph: dict[str, Any] = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": FLUXED_UP, "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": CLIP_L, "clip_name2": T5, "type": "flux"}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": options["width"], "height": options["height"], "batch_size": 1}},
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["8", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"image-{job_id}", "images": ["9", 0]}},
    }
    model_input: list[Any] = ["1", 0]
    clip_input: list[Any] = ["2", 0]
    for index, lora in enumerate(options["loras"]):
        node_id = str(20 + index)
        graph[node_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": model_input,
                "clip": clip_input,
                "lora_name": lora["filename"],
                "strength_model": lora["strength"],
                "strength_clip": lora["strength"],
            },
        }
        model_input = [node_id, 0]
        clip_input = [node_id, 1]
    graph["4"] = {"class_type": "CLIPTextEncode", "inputs": {"text": options["prompt"], "clip": clip_input}}
    graph["5"] = {"class_type": "FluxGuidance", "inputs": {"conditioning": ["4", 0], "guidance": options["cfg"]}}
    graph["11"] = {"class_type": "CLIPTextEncode", "inputs": {"text": options["negative_prompt"], "clip": clip_input}}
    graph["7"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": model_input,
            "seed": options["seed"],
            "steps": options["steps"],
            "cfg": 1.0,
            "sampler_name": sampler_name,
            "scheduler": "simple",
            "positive": ["5", 0],
            "negative": ["11", 0],
            "latent_image": ["6", 0],
            "denoise": 1.0,
        },
    }
    return graph`,
  ],
  [
    String.raw`def workflow_metadata(options: dict[str, Any]) -> dict[str, Any]:
    return {"mode": "text_generation", "transformer": FLUXED_UP, "lora": AIDMA, "vae": VAE, "clip_l": CLIP_L, "t5": T5, "sampling_mode": "flow_match_euler" if options["sampler"] == "FlowMatch" else "euler", "seed": options["seed"], "width": options["width"], "height": options["height"]}`,
    String.raw`def workflow_metadata(options: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": "text_generation",
        "transformer": FLUXED_UP,
        "loras": [{"filename": item["filename"], "strength": item["strength"]} for item in options["loras"]],
        "negative_prompt_present": bool(options["negative_prompt"]),
        "vae": VAE,
        "clip_l": CLIP_L,
        "t5": T5,
        "sampling_mode": "flow_match_euler" if options["sampler"] == "FlowMatch" else "euler",
        "seed": options["seed"],
        "width": options["width"],
        "height": options["height"],
    }`,
  ],
  [
    String.raw`def assert_node_classes(object_info: object) -> None:
    available = set(object_info) if isinstance(object_info, dict) else set()
    missing = sorted(REQUIRED_NODE_CLASSES.difference(available))
    if missing:
        raise ValueError("runtime_missing_nodes:" + ",".join(missing))`,
    String.raw`def assert_node_classes(object_info: object, require_lora: bool = True) -> None:
    available = set(object_info) if isinstance(object_info, dict) else set()
    required = REQUIRED_NODE_CLASSES if require_lora else REQUIRED_NODE_CLASSES.difference({"LoraLoader"})
    missing = sorted(required.difference(available))
    if missing:
        raise ValueError("runtime_missing_nodes:" + ",".join(missing))`,
  ],
] as const;

export function applyPublishedAgentSourcePatch(source: Buffer) {
  let materialized = source.toString("utf8");
  for (const [search, replacement] of RTX4090_GOLDEN_AGENT_SOURCE_PATCHES) {
    const first = materialized.indexOf(search);
    if (first < 0 || materialized.indexOf(search, first + search.length) >= 0) {
      throw new Error("golden_agent_source_patch_context_mismatch");
    }
    materialized = `${materialized.slice(0, first)}${replacement}${materialized.slice(first + search.length)}`;
  }
  return Buffer.from(materialized, "utf8");
}

export function applyPublishedWorkflowSourcePatch(source: Buffer) {
  let materialized = source.toString("utf8");
  for (const [search, replacement] of RTX4090_GOLDEN_WORKFLOW_SOURCE_PATCHES) {
    const first = materialized.indexOf(search);
    if (first < 0 || materialized.indexOf(search, first + search.length) >= 0) {
      throw new Error("golden_workflow_source_patch_context_mismatch");
    }
    materialized = `${materialized.slice(0, first)}${replacement}${materialized.slice(first + search.length)}`;
  }
  return Buffer.from(materialized, "utf8");
}

export function applyPublishedControllerSourcePatch(source: Buffer) {
  let materialized = source.toString("utf8");
  for (const [search, replacement] of RTX4090_GOLDEN_CONTROLLER_SOURCE_PATCHES) {
    const first = materialized.indexOf(search);
    if (first < 0 || materialized.indexOf(search, first + search.length) >= 0) {
      throw new Error("golden_controller_source_patch_context_mismatch");
    }
    materialized = `${materialized.slice(0, first)}${replacement}${materialized.slice(first + search.length)}`;
  }
  return Buffer.from(materialized, "utf8");
}

function buildBootstrap(input: Rtx4090GoldenDeploymentProfile["immutable"] & { tokenSha256: string }) {
  const urls = immutablePublicSourceEndpoints(input.commit, "scripts/clore/diagnostic-agent.py").map((endpoint) => endpoint.url);
  const compression = { level: 9 } as const;
  const patch = deflateRawSync(Buffer.from(JSON.stringify(RTX4090_GOLDEN_AGENT_SOURCE_PATCHES), "utf8"), compression).toString("base64");
  const controllerPatch = deflateRawSync(Buffer.from(JSON.stringify(RTX4090_GOLDEN_CONTROLLER_SOURCE_PATCHES), "utf8"), compression).toString("base64");
  const workflowPatch = deflateRawSync(Buffer.from(JSON.stringify(RTX4090_GOLDEN_WORKFLOW_SOURCE_PATCHES), "utf8"), compression).toString("base64");
  const program = [
    "import urllib.request as u,hashlib as h,os,json,base64,zlib,functools as f",
    `urls=${JSON.stringify(urls)}`,
    "d=None",
    "for x in urls:",
    " try:",
    "  r=u.urlopen(x,timeout=30)",
    "  if getattr(r,'status',200)!=200: continue",
    "  b=r.read(2097153)",
    "  if len(b)>2097152: continue",
    "  c=(r.headers.get('Content-Type') or '').split(';',1)[0].strip().lower()",
    "  if c not in ('application/octet-stream','application/x-python','text/plain','text/x-python'):",
    "   try:",
    "    t=b.decode('utf-8');s=t.lstrip()[:32].lower()",
    "    if chr(0) in t or any(ord(ch)<32 and ch not in '\\t\\n\\r' for ch in t) or s.startswith('<!doctype html') or s.startswith('<html'): continue",
    "   except UnicodeDecodeError: continue",
    `  if h.sha256(b).hexdigest()!='${input.agentSourceSha256}': raise RuntimeError('immutable_source_hash_mismatch')`,
    "  d=b;break",
    " except RuntimeError: raise",
    " except Exception: pass",
    "if d is None: raise RuntimeError('immutable_source_unavailable')",
    `q=json.loads(zlib.decompress(base64.b64decode('${patch}'),-15))`,
    "d=f.reduce(lambda x,y:x.replace(y[0],y[1]),q,d.decode()).encode()",
    `assert h.sha256(d).hexdigest()=='${input.agentSha256}'`,
    "p='/tmp/a.py';open(p,'wb').write(d)",
    `os.execvp('python3',['python3',p,'--token-sha256','${input.tokenSha256}','--immutable','${input.commit}:${input.controllerSha256}:${input.workflowSha256}','--controller-source-sha256','${input.controllerSourceSha256}','--controller-patch','${controllerPatch}','--workflow-source-sha256','${input.workflowSourceSha256}','--workflow-patch','${workflowPatch}'])`,
  ].join("\n");
  const encoded = deflateRawSync(Buffer.from(program, "utf8"), compression).toString("base64");
  return `python3 -c "import base64,zlib;exec(zlib.decompress(base64.b64decode('${encoded}'),-15))"`;
}

const templateTokenSha256 = "0".repeat(64);
export const RTX4090_GOLDEN_DEPLOYMENT_PROFILE: Rtx4090GoldenDeploymentProfile = {
  id: "rtx4090-golden-agent-v1",
  gpuClass: "rtx4090",
  supportedDimensions: { maxWidth: 1280, maxHeight: 1280 },
  image: "cloreai/jupyter:ubuntu24.04-v2",
  ports: { "8080": "http" },
  healthPath: "/healthz",
  controllerBind: "0.0.0.0:8080",
  immutable,
  agentContract: "stage-acceptance-v2",
  acceptedStageResponseFields: ["accepted", "state", "status", "stage", "stage_run_id"],
  bootstrapTemplateSha256: createHash("sha256").update(buildBootstrap({ ...immutable, tokenSha256: templateTokenSha256 })).digest("hex"),
};

export function rtx4090GoldenDeploymentFingerprint(profile = RTX4090_GOLDEN_DEPLOYMENT_PROFILE) {
  const canonicalIdentity = {
    scope: "clore-rtx4090-deployment-profile-v1",
    id: profile.id,
    gpuClass: profile.gpuClass,
    supportedDimensions: {
      maxWidth: profile.supportedDimensions.maxWidth,
      maxHeight: profile.supportedDimensions.maxHeight,
    },
    image: profile.image,
    ports: { "8080": profile.ports["8080"] },
    healthPath: profile.healthPath,
    controllerBind: profile.controllerBind,
    immutable: {
      commit: profile.immutable.commit,
      agentSourceSha256: profile.immutable.agentSourceSha256,
      agentSha256: profile.immutable.agentSha256,
      controllerSourceSha256: profile.immutable.controllerSourceSha256,
      controllerSha256: profile.immutable.controllerSha256,
      workflowSourceSha256: profile.immutable.workflowSourceSha256,
      workflowSha256: profile.immutable.workflowSha256,
    },
    agentContract: profile.agentContract,
    acceptedStageResponseFields: [...profile.acceptedStageResponseFields],
    bootstrapTemplateSha256: profile.bootstrapTemplateSha256,
  };
  return createHash("sha256").update(JSON.stringify(canonicalIdentity)).digest("hex");
}

export function buildRtx4090GoldenBootstrap(tokenSha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(tokenSha256)) throw new Error("golden_deployment_token_hash_invalid");
  const command = buildBootstrap({ ...RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable, tokenSha256 });
  // The immutable workflow overlay is bounded and still well below the
  // remote shell/HTTP command budget; keep an explicit upper bound.
  if (Buffer.byteLength(command, "utf8") >= 16_384) throw new Error("golden_deployment_bootstrap_too_long");
  return command;
}

export function rtx4090GoldenBootstrapByteLength(tokenSha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(tokenSha256)) throw new Error("golden_deployment_token_hash_invalid");
  return Buffer.byteLength(buildBootstrap({ ...RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable, tokenSha256 }), "utf8");
}

export function assertRtx4090GoldenDeploymentProfile(profile = RTX4090_GOLDEN_DEPLOYMENT_PROFILE) {
  if (profile.image !== "cloreai/jupyter:ubuntu24.04-v2" || profile.ports["8080"] !== "http" || profile.healthPath !== "/healthz" || profile.controllerBind !== "0.0.0.0:8080" || profile.agentContract !== "stage-acceptance-v2" || profile.acceptedStageResponseFields.join(",") !== "accepted,state,status,stage,stage_run_id") {
    throw new Error("rtx4090_golden_deployment_profile_drift");
  }
  const expected = createHash("sha256").update(buildBootstrap({ ...profile.immutable, tokenSha256: templateTokenSha256 })).digest("hex");
  if (expected !== profile.bootstrapTemplateSha256) throw new Error("rtx4090_golden_bootstrap_hash_mismatch");
  const localAgent = createHash("sha256").update(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "clore", "diagnostic-agent.py"))).digest("hex");
  if (localAgent !== profile.immutable.agentSha256) throw new Error("rtx4090_golden_agent_contract_source_mismatch");
  const localController = createHash("sha256").update(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "comfy-runtime", "controller.py"))).digest("hex");
  if (localController !== profile.immutable.controllerSha256) throw new Error("rtx4090_golden_controller_source_mismatch");
  const localWorkflow = createHash("sha256").update(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "comfy-runtime", "image_workflow.py"))).digest("hex");
  if (localWorkflow !== profile.immutable.workflowSha256) throw new Error("rtx4090_golden_workflow_source_mismatch");
  return profile;
}

type GoldenSourceRole = "agent" | "controller" | "workflow";

type GoldenResolvedSource = {
  role: GoldenSourceRole;
  sourcePath: string;
  resolved: ResolvedImmutableSource;
};

function immutableSourceEvidencePath() {
  return path.join(process.cwd(), ".secrets", "diagnostics", "rtx4090-immutable-source-preflight.json");
}

function writeImmutableSourceEvidence(filePath: string | false | undefined, value: unknown) {
  if (filePath === false) return;
  const target = path.resolve(filePath ?? immutableSourceEvidencePath());
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

function resolvedSourceProjection(source: GoldenResolvedSource) {
  const verifiedEndpoint = [...source.resolved.evidence].reverse().find((entry) =>
    entry.classification === "verified" || entry.classification === "cache_verified");
  return {
    source: source.resolved.source,
    endpointId: source.resolved.endpointId,
    httpStatus: verifiedEndpoint?.httpStatus ?? null,
    contentType: verifiedEndpoint?.contentType ?? null,
    bytes: source.resolved.bytes.length,
    sha256: source.resolved.sha256,
    evidence: source.resolved.evidence,
  };
}

export async function verifyRtx4090GoldenPublishedSources(options: {
  fetchImpl?: typeof fetch;
  cacheRoot?: string;
  timeoutMs?: number;
  evidencePath?: string | false;
  endpointFactory?: (input: {
    role: GoldenSourceRole;
    commit: string;
    sourcePath: string;
  }) => ImmutableSourceEndpoint[];
} = {}) {
  const profile = assertRtx4090GoldenDeploymentProfile();
  const profileFingerprint = rtx4090GoldenDeploymentFingerprint(profile);
  const specifications = [
    {
      role: "agent" as const,
      sourcePath: "scripts/clore/diagnostic-agent.py",
      expectedSha256: profile.immutable.agentSourceSha256,
    },
    {
      role: "controller" as const,
      sourcePath: "comfy-runtime/controller.py",
      expectedSha256: profile.immutable.controllerSourceSha256,
    },
    {
      role: "workflow" as const,
      sourcePath: "comfy-runtime/image_workflow.py",
      expectedSha256: profile.immutable.workflowSourceSha256,
    },
  ];
  const completed: GoldenResolvedSource[] = [];
  let activeRole: GoldenSourceRole | null = null;
  try {
    for (const specification of specifications) {
      activeRole = specification.role;
      const resolved = await resolveImmutableSource({
        profileFingerprint,
        commit: profile.immutable.commit,
        sourcePath: specification.sourcePath,
        expectedSha256: specification.expectedSha256,
        cacheRoot: options.cacheRoot,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        endpoints: options.endpointFactory?.({
          role: specification.role,
          commit: profile.immutable.commit,
          sourcePath: specification.sourcePath,
        }),
      });
      completed.push({ role: specification.role, sourcePath: specification.sourcePath, resolved });
    }
    const agentSource = completed.find((source) => source.role === "agent");
    const controller = completed.find((source) => source.role === "controller");
    const workflow = completed.find((source) => source.role === "workflow");
    if (!agentSource || !controller || !workflow) throw new Error("golden_runtime_source_bundle_incomplete");
    const materializedAgentSha256 = createHash("sha256")
      .update(applyPublishedAgentSourcePatch(agentSource.resolved.bytes))
      .digest("hex");
    if (materializedAgentSha256 !== profile.immutable.agentSha256) {
      throw new Error("golden_runtime_materialized_agent_sha256_mismatch");
    }
    const materializedControllerSha256 = createHash("sha256")
      .update(applyPublishedControllerSourcePatch(controller.resolved.bytes))
      .digest("hex");
    if (materializedControllerSha256 !== profile.immutable.controllerSha256) {
      throw new Error("golden_runtime_materialized_controller_sha256_mismatch");
    }
    const materializedWorkflowSha256 = createHash("sha256")
      .update(applyPublishedWorkflowSourcePatch(workflow.resolved.bytes))
      .digest("hex");
    if (materializedWorkflowSha256 !== profile.immutable.workflowSha256) {
      throw new Error("golden_runtime_materialized_workflow_sha256_mismatch");
    }
    const result = {
      classification: "published_sources_verified" as const,
      verifiedAt: new Date().toISOString(),
      profileFingerprint,
      commit: profile.immutable.commit,
      agent: {
        ...resolvedSourceProjection(agentSource),
        sourceBytes: agentSource.resolved.bytes.length,
        sourceSha256: agentSource.resolved.sha256,
        materializedSha256: materializedAgentSha256,
      },
      controller: {
        ...resolvedSourceProjection(controller),
        sourceBytes: controller.resolved.bytes.length,
        sourceSha256: controller.resolved.sha256,
        materializedSha256: materializedControllerSha256,
      },
      workflow: {
        ...resolvedSourceProjection(workflow),
        sourceBytes: workflow.resolved.bytes.length,
        sourceSha256: workflow.resolved.sha256,
        materializedSha256: materializedWorkflowSha256,
      },
    };
    writeImmutableSourceEvidence(options.evidencePath, result);
    return result;
  } catch (error) {
    const failure = {
      classification: "immutable_source_preflight_failed",
      failedAt: new Date().toISOString(),
      profileFingerprint,
      commit: profile.immutable.commit,
      failedRole: activeRole,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      completed: completed.map(resolvedSourceProjection),
      evidence: error instanceof ImmutableSourceResolutionError ? error.evidence : [],
    };
    writeImmutableSourceEvidence(options.evidencePath, failure);
    throw error;
  }
}
