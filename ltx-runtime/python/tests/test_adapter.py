import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from ltx_runtime.adapter import LtxRuntimeAdapter, RuntimeBlocked, _canonical_manifest_digest


class AdapterTests(unittest.TestCase):
    def test_blocked_manifest_never_builds_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = {"schemaVersion": 2, "modelKey": "blocked", "files": [], "executableStatus": "blocked", "blockerReason": "evidence_incomplete", "officialRuntimeSource": {"revision": "9377758131b1ffde4b7f766804590a6617bf2ab9"}, "pipeline": {"id": "official-distilled"}}
            payload["manifestSha256"] = _canonical_manifest_digest(payload)
            manifest = root / "manifest.json"; manifest.write_text(json.dumps(payload), encoding="utf-8")
            adapter = LtxRuntimeAdapter(manifest, root / "models", root / "jobs", root / "output")
            with self.assertRaisesRegex(RuntimeBlocked, "model_blocked"):
                adapter.load_manifest()

    def test_tampering_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = root / "manifest.json"
            manifest.write_text('{"schemaVersion":2,"manifestSha256":"bad"}', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeBlocked, "manifest_sha256_mismatch"):
                LtxRuntimeAdapter(manifest, root, root, root).load_manifest()


if __name__ == "__main__":
    unittest.main()
