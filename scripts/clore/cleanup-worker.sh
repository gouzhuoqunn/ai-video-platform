#!/usr/bin/env bash
set -euo pipefail

echo "Cleaning temporary GPU job files only."
rm -rf /workspace/jobs/*
mkdir -p /workspace/jobs
echo "Cleanup complete. Model cache and Supabase private videos are not touched. Run this before canceling a Clore order."
