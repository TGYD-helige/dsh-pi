#!/usr/bin/env bash
# Clean-room install gate for dsh-pi-host.
#
# Reproduces the README install path with no reused caches and a fresh DSH home:
#   1. install the pinned DSH CLI into an isolated prefix
#   2. install dsh-pi-host plus one Pi extension into a fresh profile
#   3. `dsh --profile demo --dump-config` must succeed and show the configured extension
#   4. the host must mount at least one Pi extension tool
#
# Usage:
#   scripts/clean-install-smoke.sh [options]
#     --host-spec <spec>    registry version or dist-tag to install instead of this checkout;
#                           the default packs this checkout, which is what a release publishes
#     --dsh-version <ver>   @deepseek-ai/dsh CLI version (default: 0.1.5-rc.2)
#     --extension <pkg>     Pi extension installed next to the host (default: @amaster.ai/pi-image-gen)
#     --pi-version <ver>    override the installed @earendil-works/pi-coding-agent version after
#                           install; `latest` probes the newest upstream before we adopt it
#     --keep                keep the temporary work directory
#
# Exit codes: 0 = gate passed, 1 = gate failed, 2 = unusable environment.
set -euo pipefail

host_spec=""
dsh_version="0.1.5-rc.2"
extension="@amaster.ai/pi-image-gen"
pi_version=""
keep=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host-spec) host_spec="${2:-}"; shift 2 ;;
    --dsh-version) dsh_version="${2:-}"; shift 2 ;;
    --extension) extension="${2:-}"; shift 2 ;;
    --pi-version) pi_version="${2:-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# A packed tarball is installed by path; everything else is an npm version or dist-tag.
case "$host_spec" in
  "") host_target="" ;;
  *.tgz|/*) host_target="$host_spec" ;;
  *) host_target="dsh-pi-host@$host_spec" ;;
esac

for tool in node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 2; }
done
# `dsh plugin` forwards to pnpm; install a local one if the host has none.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "missing required tool: pnpm (install pnpm@10.28.2, see README)" >&2
  exit 2
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/dsh-pi-clean-install.XXXXXX")
cleanup() {
  status=$?
  if [ "$keep" -eq 1 ] || [ "$status" -ne 0 ]; then
    echo "work directory kept for inspection: $work"
  else
    rm -rf "$work"
  fi
  return "$status"
}
trap cleanup EXIT

# No reused caches: fresh npm cache, fresh pnpm store, fresh DSH home.
export npm_config_cache="$work/npm-cache"
export npm_config_store_dir="$work/pnpm-store"
export DSH_HOME="$work/dsh-home"
export CI=true
mkdir -p "$work/cli" "$DSH_HOME"
printf '{"name":"dsh-pi-clean-install","private":true}\n' > "$work/cli/package.json"

echo "== environment"
echo "node=$(node -v) npm=$(npm -v) pnpm=$(pnpm -v)"
echo "dsh=$dsh_version host=${host_target:-<packed checkout>} extension=$extension pi=${pi_version:-<pinned>}"
echo "work=$work"

if [ -z "$host_target" ]; then
  echo "== pack this checkout"
  version=$(node -p "require('$repo_root/package.json').version")
  (cd "$repo_root" && pnpm pack --pack-destination "$work" > "$work/pack.log" 2>&1)
  host_target="$work/dsh-pi-host-$version.tgz"
  echo "tarball=$host_target"
fi

echo "== install DSH CLI @deepseek-ai/dsh@$dsh_version"
npm install --prefix "$work/cli" --no-audit --no-fund "@deepseek-ai/dsh@$dsh_version" > "$work/cli-install.log" 2>&1
export PATH="$work/cli/node_modules/.bin:$PATH"
echo "dsh=$(dsh --version)"

echo "== install bundle into profile demo"
dsh plugin --profile demo add "$host_target" "$extension" > "$work/plugin-add.log" 2>&1
profile="$DSH_HOME/profiles/demo"

cat > "$profile/cordis.patch.yml" <<EOF
- id: dsh-pi
  config:
    extensions:
      - '$extension'
    projectTrusted: false
    allowLocalPaths: false
    strict: false
    flags: {}
EOF

echo "== dsh --profile demo --dump-config"
dsh --profile demo --dump-config > "$work/dump-config.yml" 2> "$work/dump-config.err"
grep -q -- '- id: dsh-pi' "$work/dump-config.yml"
grep -q -- "$extension" "$work/dump-config.yml"

if [ -n "$pi_version" ]; then
  echo "== probe @earendil-works/pi-coding-agent@$pi_version"
  # Override the profile resolution so the host itself runs on the probed version: a hoisted or
  # overridden Pi is exactly how a user ends up on a version the host was not built for.
  (cd "$profile" && node -e '
    const fs = require("node:fs")
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"))
    manifest.pnpm = { ...(manifest.pnpm ?? {}), overrides: { "@earendil-works/pi-coding-agent": process.argv[1] } }
    fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\n")
  ' "$pi_version"
  pnpm install --no-frozen-lockfile > "$work/pi-install.log" 2>&1)
  echo "pi=$(node -p "require('$profile/node_modules/@earendil-works/pi-coding-agent/package.json').version")"
fi

echo "== mount Pi extension tools"
cp "$repo_root/scripts/compat/list-tools.mjs" "$profile/list-tools.mjs"
# Install accepts a version spec; resolution inside the profile uses the bare package name.
extension_name="$extension"
case "$extension" in
  @*/*@*) extension_name="${extension%@*}" ;;
  @*) extension_name="$extension" ;;
  *@*) extension_name="${extension%@*}" ;;
esac
(cd "$profile" && node list-tools.mjs "$extension_name") > "$work/tools.txt" 2> "$work/tools.err"

tools=$(sed -n 's/^TOOLS=//p' "$work/tools.txt")
host_version=$(sed -n 's/^HOST_VERSION=//p' "$work/tools.txt")
pi_resolved=$(sed -n 's/^PI_VERSION=//p' "$work/tools.txt")
[ -n "$tools" ] || { echo "no TOOLS= line from list-tools.mjs" >&2; exit 1; }

echo
echo "== result"
echo "host_version=$host_version"
echo "pi_version=$pi_resolved"
echo "installed dsh-pi-host=$(node -p "require('$profile/node_modules/dsh-pi-host/package.json').version")"
echo "dump_config=$work/dump-config.yml"
echo "tools=$tools"
echo "log_dir=$work"
echo "PASS clean install mounted $(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).length))" "$tools") Pi extension tool(s)"