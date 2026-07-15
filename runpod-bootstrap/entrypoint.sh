#!/usr/bin/env bash
set -euo pipefail

public_key="${SSH_PUBLIC_KEY:-}"
if [[ ! "${public_key}" =~ ^ssh-(ed25519|rsa|ecdsa-[^[:space:]]+)[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || [[ "${public_key}" == *"PRIVATE KEY"* ]] || [[ "${public_key}" == *$'\n'* ]] || [[ "${public_key}" == *$'\r'* ]]; then
  echo "runpod_bootstrap_public_key_invalid" >&2
  exit 64
fi

install -d -m 0700 /root/.ssh
printf '%s\n' "${public_key}" > /root/.ssh/authorized_keys
chmod 0600 /root/.ssh/authorized_keys
install -d -m 0755 /run/sshd
unset SSH_PUBLIC_KEY

/usr/sbin/sshd -t
exec /usr/sbin/sshd -D -e
