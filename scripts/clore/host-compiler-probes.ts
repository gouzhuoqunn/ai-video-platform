export const HOST_TOOLCHAIN_PACKAGES = [
  "build-essential",
  "gcc",
  "g++",
  "make",
  "libc6-dev",
  "linux-libc-dev",
  "python3-dev",
  "python3-venv",
  "git",
  "curl",
  "ca-certificates",
  "pkg-config",
  "cmake",
  "ninja-build",
  "ffmpeg",
] as const;

export type HostCompilerProbe = { label: string; command: string };
export type HostProbeFailure = {
  classification: "c_headers_missing" | "python_headers_missing" | "c_compiler_missing" | "cpp_compiler_missing" | "torch_cuda_invalid" | "triton_import_failed" | "triton_compile_failed" | "unknown_probe_failure";
  missingPath: string | null;
  packages: string[];
};

const VENV_PYTHON = "/workspace/ai-runtime/venv/bin/python";
const TRITON_VECTOR_ADD = `import torch
import triton
import triton.language as tl

@triton.jit
def add_kernel(x, y, output, n_elements, BLOCK_SIZE: tl.constexpr):
    offsets = tl.program_id(0) * BLOCK_SIZE + tl.arange(0, BLOCK_SIZE)
    mask = offsets < n_elements
    tl.store(output + offsets, tl.load(x + offsets, mask=mask) + tl.load(y + offsets, mask=mask), mask=mask)

n = 1024
x = torch.arange(n, device="cuda", dtype=torch.float32)
y = torch.full((n,), 2.0, device="cuda", dtype=torch.float32)
output = torch.empty_like(x)
add_kernel[(triton.cdiv(n, 256),)](x, y, output, n, BLOCK_SIZE=256)
torch.cuda.synchronize()
maximum_error = float((output - (x + y)).abs().max().item())
assert maximum_error == 0.0
print(f"triton_vector_add_ok=true max_error={maximum_error} device={torch.cuda.get_device_name(0)}")
`;

export function stage3UHostCompilerProbes(): HostCompilerProbe[] {
  const tritonScript = Buffer.from(TRITON_VECTOR_ADD, "utf8").toString("base64");
  return [
    { label: "stdlib_header", command: "test -f /usr/include/stdlib.h && echo header=/usr/include/stdlib.h" },
    { label: "stdio_header", command: "test -f /usr/include/stdio.h && echo header=/usr/include/stdio.h" },
    { label: "python_include_directory", command: `${VENV_PYTHON} -c 'import os,sysconfig; p=sysconfig.get_paths()["include"]; print("python_include="+p); assert os.path.isdir(p)'` },
    { label: "python_header", command: `${VENV_PYTHON} -c 'import os,sysconfig; p=os.path.join(sysconfig.get_paths()["include"],"Python.h"); print("python_header="+p); assert os.path.isfile(p)'` },
    { label: "c_compile_run", command: "set -e; d=$(mktemp -d /workspace/stage3u-c.XXXXXX); trap 'rm -rf \"$d\"' EXIT; printf '%s\\n' '#include <stdlib.h>' '#include <stdio.h>' 'int main(void){void *p=malloc(1); if(!p) return 2; free(p); puts(\"c_probe_ok=true\"); return 0;}' > \"$d/main.c\"; cc \"$d/main.c\" -o \"$d/probe\"; \"$d/probe\"" },
    { label: "cpp_compile_run", command: "set -e; d=$(mktemp -d /workspace/stage3u-cpp.XXXXXX); trap 'rm -rf \"$d\"' EXIT; printf '%s\\n' '#include <iostream>' 'int main(){std::cout << \"cpp_probe_ok=true\\n\"; return 0;}' > \"$d/main.cpp\"; c++ \"$d/main.cpp\" -o \"$d/probe\"; \"$d/probe\"" },
    { label: "torch_cuda_rtx4090", command: `${VENV_PYTHON} -c 'import torch; print("torch_version="+torch.__version__); print("torch_cuda_version="+str(torch.version.cuda)); print("cuda_available="+str(torch.cuda.is_available()).lower()); d=torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none"; print("cuda_device="+d); assert torch.cuda.is_available() and "4090" in d'` },
    { label: "triton_import", command: `${VENV_PYTHON} -c 'import triton; print("triton_import_ok=true triton_version="+str(triton.__version__))'` },
    { label: "triton_vector_add", command: `set -e; printf '%s' '${tritonScript}' | base64 -d > /workspace/stage3u-triton-probe.py; ${VENV_PYTHON} /workspace/stage3u-triton-probe.py; rm -f /workspace/stage3u-triton-probe.py` },
  ];
}

export function parseTritonProbeOutput(output: string) {
  const match = output.match(/triton_vector_add_ok=(true|false)\s+max_error=([0-9.eE+-]+)/);
  if (!match) return { valid: false, maximumError: null };
  const maximumError = Number(match[2]);
  return { valid: match[1] === "true" && Number.isFinite(maximumError) && maximumError === 0, maximumError };
}

export function classifyHostProbeFailure(label: string, output: string): HostProbeFailure {
  const text = `${label}\n${output}`;
  if (/cpp_compile_run|c\+\+: .*not found|g\+\+: .*not found/i.test(text)) return { classification: "cpp_compiler_missing", missingPath: null, packages: ["build-essential", "g++", "make"] };
  if (/c_compiler|cc: .*not found|gcc: .*not found|Failed to find C compiler/i.test(text)) return { classification: "c_compiler_missing", missingPath: null, packages: ["build-essential", "gcc", "make"] };
  if (/stdlib\.h|stdio\.h|stdlib_header|stdio_header/i.test(text)) return { classification: "c_headers_missing", missingPath: /stdio\.h|stdio_header/i.test(text) ? "/usr/include/stdio.h" : "/usr/include/stdlib.h", packages: ["libc6-dev", "linux-libc-dev"] };
  if (/Python\.h|python_header|python_include/i.test(text)) return { classification: "python_headers_missing", missingPath: /Python\.h/i.test(text) ? "sysconfig include/Python.h" : "sysconfig include", packages: ["python3-dev"] };
  if (/torch_cuda|cuda_available=false|4090/i.test(text)) return { classification: "torch_cuda_invalid", missingPath: null, packages: [] };
  if (/triton_import/i.test(text)) return { classification: "triton_import_failed", missingPath: null, packages: [] };
  if (/triton_vector_add|triton|cuda_utils/i.test(text)) return { classification: "triton_compile_failed", missingPath: null, packages: ["build-essential", "libc6-dev", "linux-libc-dev", "python3-dev"] };
  return { classification: "unknown_probe_failure", missingPath: null, packages: [] };
}

export function hostProbeCorrectionCommand(failure: HostProbeFailure) {
  if (failure.classification === "torch_cuda_invalid") return `${VENV_PYTHON} -m pip install --force-reinstall --index-url https://download.pytorch.org/whl/cu124 'torch==2.6.0' 'torchvision==0.21.0' 'torchaudio==2.6.0'`;
  if (failure.classification === "triton_import_failed") return `${VENV_PYTHON} -m pip install --force-reinstall 'triton==3.2.0'`;
  if (failure.packages.length === 0) return null;
  const packages = failure.packages.join(" ");
  const pythonDev = failure.classification === "python_headers_missing" || failure.classification === "triton_compile_failed"
    ? "pyver=$(python3 -c 'import sys; print(f\"{sys.version_info.major}.{sys.version_info.minor}\")'); pydev=python${pyver}-dev; apt-cache show \"$pydev\" >/dev/null 2>&1 || pydev=python3-dev; "
    : "";
  return `set -e; apt-get update; ${pythonDev}DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages}${pythonDev ? ' "$pydev"' : ""}`;
}
