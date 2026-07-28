#!/usr/bin/env python3
"""Focused resumable-download tests for the restricted Agent."""
import hashlib, importlib.util, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]; PATH = ROOT / "scripts" / "clore" / "diagnostic-agent.py"
def load():
    spec=importlib.util.spec_from_file_location("agent_download_test", PATH); assert spec and spec.loader
    value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
class Response:
    def __init__(self, data, status=200, headers=None): self.data=data; self.status=status; self.headers=headers or {}; self.offset=0
    def read(self, size=-1):
        if size < 0: size=len(self.data)-self.offset
        out=self.data[self.offset:self.offset+size]; self.offset+=len(out); return out
    def close(self): pass
    def __enter__(self): return self
    def __exit__(self,*_): self.close()
    def geturl(self): return "https://models.example/download?token=secret"
def entry(agent, root, data):
    return {
        "kind": "base",
        "role": "transformer",
        "state_bucket": "models",
        "state_key": "transformer",
        "filename": "fixture.bin",
        "url": "https://models.example/download?token=secret",
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
        "destination": str(root / "fixture.bin"),
    }
def main():
    agent=load(); agent.time.sleep=lambda *_:None
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp); agent.ROOT=root; agent.STATE_FILE=root/"state.json"; agent.STATE={"alive":True,"stages":{},"models":{}}; data=b"abcdefghij"; item=entry(agent,root,data); calls=[]; original=agent.urllib.request.urlopen
        def fresh(request, **_): calls.append(request); return Response(data,200,{"Content-Length":str(len(data))})
        agent.urllib.request.urlopen=fresh
        try: assert agent.stream_model(item)["status"]=="verified"; assert len(calls)==1 and calls[0].get_header("Accept-encoding")=="identity"
        finally: agent.urllib.request.urlopen=original
        (root/"fixture.bin").unlink(); (root/"fixture.bin.part").write_bytes(data[:4]); calls=[]
        def resume(request, **_):
            calls.append(request); return Response(data[4:],206,{"Content-Range":"bytes 4-9/10","Content-Length":"6"})
        agent.urllib.request.urlopen=resume
        try: assert agent.stream_model(item)["status"]=="verified"; assert calls[0].get_header("Range")=="bytes=4-"
        finally: agent.urllib.request.urlopen=original
        (root/"fixture.bin").unlink(); (root/"fixture.bin.part").write_bytes(data[:4])
        agent.urllib.request.urlopen=lambda *_args,**_kwargs: Response(data[4:],206,{"Content-Range":"bytes 3-9/10","Content-Length":"6"})
        try:
            try: agent.stream_model(item)
            except agent.StageFailure as error: assert error.data["code"]=="model_download_invalid_range" and (root/"fixture.bin.part").read_bytes()==data[:4]
            else: raise AssertionError("invalid range accepted")
        finally: agent.urllib.request.urlopen=original
        (root/"fixture.bin.part").unlink(missing_ok=True); attempts=[]
        def short(request, **_): attempts.append(request); return Response(data[:3],200,{"Content-Length":"10"}) if len(attempts)==1 else Response(b"",206,{"Content-Range":"bytes 3-9/10","Content-Length":"7"})
        agent.urllib.request.urlopen=short
        try:
            try: agent.stream_model(item)
            except agent.StageFailure as error: assert error.data["code"]=="model_download_incomplete_after_retries" and error.data["actual_bytes"]==3 and "secret" not in str(error.data)
            else: raise AssertionError("incomplete accepted")
        finally: agent.urllib.request.urlopen=original
    print('{"ok":true,"fresh_and_resume":true,"exact_range":true,"invalid_range_rejected":true,"incomplete_structured":true,"credentials_redacted":true}')
if __name__=="__main__": main()
