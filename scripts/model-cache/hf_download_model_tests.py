#!/usr/bin/env python3

import importlib.util
from pathlib import Path
import tempfile


MODULE_PATH = Path(__file__).with_name("hf_download_model.py")
SPEC = importlib.util.spec_from_file_location("hf_download_model", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


assert MODULE.should_fallback(0, 601, 600, "xet") is True
assert MODULE.should_fallback(0, 601, 600, "http") is False
assert MODULE.should_fallback(10, 609, 600, "xet") is False
assert "HF_HUB_ENABLE_HF_TRANSFER" not in MODULE_PATH.read_text(encoding="utf-8")
assert MODULE.MODELS["qwen"]["size"] == 8_044_982_048
assert MODULE.MODELS["vae"]["size"] == 336_211_292

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / "part.incomplete").write_bytes(b"x" * 17)
    current, total = MODULE.cache_progress(root, 100)
    assert current == 17
    assert total == 17

print("Official Hugging Face Xet fallback and progress tests passed.")
