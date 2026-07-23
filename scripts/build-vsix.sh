#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
cd "$project_dir"

install_after_build=false
if [[ "${1:-}" == "--install" ]]; then
  install_after_build=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--install]\n' "$0" >&2
  exit 2
fi

if [[ ! -x node_modules/.bin/vsce ]]; then
  printf 'Installing locked dependencies with npm ci...\n'
  npm ci
fi

detect_target() {
  local system machine
  system="$(uname -s)"
  machine="$(uname -m)"
  case "$system:$machine" in
    Darwin:arm64) printf 'darwin-arm64' ;;
    Darwin:x86_64) printf 'darwin-x64' ;;
    Linux:aarch64|Linux:arm64) printf 'linux-arm64' ;;
    Linux:x86_64|Linux:amd64) printf 'linux-x64' ;;
    MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) printf 'win32-x64' ;;
    MINGW*:aarch64|MSYS*:aarch64|CYGWIN*:aarch64) printf 'win32-arm64' ;;
    *)
      printf 'Unsupported build platform %s/%s. Set VSCE_TARGET explicitly.\n' "$system" "$machine" >&2
      return 1
      ;;
  esac
}

target="${VSCE_TARGET:-$(detect_target)}"
version="$(node -p "require('./package.json').version")"
output_dir="$project_dir/dist"
vsix_path="$output_dir/orchestrator-code-$version-$target.vsix"

mkdir -p "$output_dir"
npm run build
node_modules/.bin/vsce package --target "$target" --out "$vsix_path"

printf 'VSIX created: %s\n' "$vsix_path"

if [[ "$install_after_build" == true ]]; then
  code_command="${CODE_BIN:-}"
  if [[ -z "$code_command" ]]; then
    if command -v code >/dev/null 2>&1; then
      code_command="code"
    elif [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
      code_command="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    else
      code_command="code"
    fi
  fi
  if ! command -v "$code_command" >/dev/null 2>&1; then
    printf 'VS Code CLI not found: %s. Set CODE_BIN to its executable.\n' "$code_command" >&2
    exit 1
  fi
  "$code_command" --install-extension "$vsix_path" --force
  printf 'Installed %s. Reload VS Code to activate it.\n' "$vsix_path"
fi
