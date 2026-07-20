# pyopenjtalk 0.4.1 Windows provenance

PyPI's official release JSON for `pyopenjtalk==0.4.1` lists one source
distribution, `pyopenjtalk-0.4.1.tar.gz`, SHA-256
`d5ada46f7fc2b52c1c79c273eb9668ff6ad7ab276a8db9d8be119ef93440f0dc`.
It does not list a CPython 3.10 Windows x64 wheel, so the local laptop must not
fall back to a global compiler installation.

`.github/workflows/build-pyopenjtalk-windows-wheel.yml` is the Path B build:
it is manually dispatched on a free GitHub-hosted `windows-2022` runner,
selects CPython 3.10 x64, downloads that exact official source distribution,
verifies its SHA-256, and builds exactly one wheel using the runner-provided
MSVC toolchain. It clean-installs the wheel and verifies the deterministic
Japanese `g2p("こんにちは")` smoke result before uploading only the wheel and a
provenance JSON artifact. It has a 30-minute job timeout and contains no model
weights, reference audio, generated audio, or secrets.

The workflow has been added locally but has not been dispatched in this
checkpoint because GitHub connectivity is currently reset during normal push.
Until a successful artifact can be retrieved, verified, and installed into
`local-data/voice/runtime-envs/gpt-sovits`, the precise blocker is
`blocked_pyopenjtalk_artifact_download`.

Path C is intentionally not executed. If explicitly approved later, the
minimum local requirement is Microsoft C++ Build Tools with the MSVC x64/x86
toolset, Windows SDK, and CMake/Ninja support (roughly several GB of disk; no
reboot is normally required). Install only through the official installer or
approved unattended command, then uninstall the Build Tools workload from Apps
or rerun the official installer to remove it. Do not install the full Visual
Studio IDE or alter the global PATH for this project.
