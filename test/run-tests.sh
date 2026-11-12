#!/bin/sh
# Regression tests for pi-profile-check.
#
# Structural cases run anywhere. The measurement comparison is asserted through
# --measure-json (a test seam), and one integration case runs the real Pi CLI when
# a build is found; point PI_CLI at a Pi coding-agent CLI entry to force one:
#
#   PI_CLI=/path/to/@earendil-works/pi-coding-agent/dist/cli.js sh test/run-tests.sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHECK="$ROOT/bin/pi-profile-check.mjs"
FIXTURES="$ROOT/fixtures"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
skip=0

# expect <name> <wanted-exit> <agentsDir|-> <extra args...>
expect() {
  name=$1
  want=$2
  dir=$3
  shift 3
  if [ "$dir" = "-" ]; then
    out=$(env -u PI_CODING_AGENT_DIR node "$CHECK" "$@" 2>&1)
  else
    out=$(PI_CODING_AGENT_DIR="$dir" node "$CHECK" "$@" 2>&1)
  fi
  got=$?
  if [ "$got" -eq "$want" ]; then
    pass=$((pass + 1))
    printf 'PASS  %-32s exit=%s\n' "$name" "$got"
  else
    fail=$((fail + 1))
    printf 'FAIL  %-32s exit=%s want=%s\n' "$name" "$got" "$want"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
}

agent_dir() {
  d="$WORK/$1"
  mkdir -p "$d"
  printf '%s\n' "$d"
}

# write_settings <dir> <comma separated package entries>
write_settings() {
  printf '{\n  "packages": [%s]\n}\n' "$2" > "$1/settings.json"
}

measure_available() {
  if [ -n "${PI_CLI:-}" ] && [ -f "${PI_CLI}" ]; then return 0; fi
  ls "$HOME"/.lody/agent-binaries/pi/*/node/package/node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
    >/dev/null 2>&1
}

MEASURE=0
measure_available && MEASURE=1

# 1. usage error: no agent directory given
expect "no-agents-dir" 2 - --no-measure

# 2. declared but not installed
d=$(agent_dir missing)
write_settings "$d" '"/nonexistent/fixture-pkg"'
expect "missing-package" 1 "$d" --no-measure

# 3. git source installed under <agentDir>/git/<host>/<path>: pin mismatch, then match
d=$(agent_dir gitpin)
mkdir -p "$d/git/github.com/fixture/pkg-alpha"
cp -R "$FIXTURES/pkg-alpha/." "$d/git/github.com/fixture/pkg-alpha/"
write_settings "$d" '"git:github.com/fixture/pkg-alpha@2.0.0"'
expect "git-source-pin-mismatch" 1 "$d" --no-measure
write_settings "$d" '"git:github.com/fixture/pkg-alpha@1.0.0"'
expect "git-source-ok" 0 "$d" --no-measure

# 4. relative local path resolves from the settings file's directory
d=$(agent_dir relative)
cp -R "$FIXTURES/pkg-alpha" "$d/pkg-alpha"
write_settings "$d" '"./pkg-alpha"'
expect "relative-local-path" 0 "$d" --no-measure

# 5. object form with skills: [] loads nothing -> against a baseline it is drift, not a problem
d=$(agent_dir skills-empty)
write_settings "$d" '{"source": "'"$FIXTURES"'/pkg-alpha", "skills": []}'
PI_CODING_AGENT_DIR="$d" node "$CHECK" --no-measure --update-baseline >/dev/null 2>&1
write_settings "$d" '"'"$FIXTURES"'/pkg-alpha"'
expect "skills-empty-vs-baseline" 3 "$d" --no-measure
expect "drift-ok-turns-green" 0 "$d" --no-measure --drift-ok

# 6. measurement comparison, injected so it never depends on Pi's loader quirks
d=$(agent_dir short-measure)
write_settings "$d" '"'"$FIXTURES"'/pkg-alpha"'
expect "measured-below-declared" 1 "$d" --baseline /dev/null --measure-json "$FIXTURES/measured-empty.json"

d=$(agent_dir exact-measure)
write_settings "$d" '"'"$FIXTURES"'/pkg-alpha"'
expect "measured-equals-declared" 0 "$d" --baseline /dev/null --measure-json "$FIXTURES/measured-alpha.json"

d=$(agent_dir over-measure)
write_settings "$d" '"'"$FIXTURES"'/pkg-alpha"'
printf '{\n  "skills": ["alpha", "beta"]\n}\n' > "$WORK/measured-over.json"
expect "measured-above-declared" 0 "$d" --baseline /dev/null --measure-json "$WORK/measured-over.json"

# 7. integration: real Pi CLI, clean profile against its own baseline
if [ "$MEASURE" -eq 1 ]; then
  d=$(agent_dir clean)
  write_settings "$d" '"'"$FIXTURES"'/pkg-alpha"'
  if [ -n "${PI_CLI:-}" ]; then
    PI_CODING_AGENT_DIR="$d" node "$CHECK" --update-baseline --pi-cli "$PI_CLI" >/dev/null 2>&1
    expect "clean-profile-real-cli" 0 "$d" --pi-cli "$PI_CLI"
  else
    PI_CODING_AGENT_DIR="$d" node "$CHECK" --update-baseline >/dev/null 2>&1
    expect "clean-profile-real-cli" 0 "$d"
  fi
else
  skip=$((skip + 1))
  printf 'SKIP  %-32s %s\n' "clean-profile-real-cli" "(no Pi CLI found)"
fi

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
