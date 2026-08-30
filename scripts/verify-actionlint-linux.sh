#!/usr/bin/env bash
set -euo pipefail

actionlint_version='1.7.12'
actionlint_sha256='8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'
actionlint_root="$(mktemp -d)"
cleanup_actionlint() {
  rm -rf -- "$actionlint_root"
}
trap cleanup_actionlint EXIT HUP INT TERM

archive="$actionlint_root/actionlint.tar.gz"
curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --proto '=https' \
  --tlsv1.2 \
  "https://github.com/rhysd/actionlint/releases/download/v${actionlint_version}/actionlint_${actionlint_version}_linux_amd64.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$actionlint_sha256" "$archive" | sha256sum --check --status
tar -xzf "$archive" -C "$actionlint_root" actionlint
"$actionlint_root/actionlint" -color
