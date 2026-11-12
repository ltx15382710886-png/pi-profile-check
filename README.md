# pi-profile-check

Verify a Pi agent profile: which packages are declared, how many skills each one contributes,
how many skills Pi actually loads, and what changed since the last time you looked.

Written for the Pi provider embedded in [Lody](https://lody.ai), where `settings.json` is the
only place that decides which package skills exist, and nothing in the UI shows them.

```
agent dir  <agentDir>   (PI_CODING_AGENT_DIR)
settings   <agentDir>/settings.json
pi cli     <agentDir>/../runtime/…/cli.js   v1.4.0

packages (5)
  npm:@scope/pi-tools@1.2.0
    → <agentDir>/npm/node_modules/@scope/pi-tools  [1.2.0 (pinned)]  8 skills
  /opt/shared/node_modules/pi-extra
    → /opt/shared/node_modules/pi-extra  [0.4.1]  0 skills

extensions via LODY_PI_EXTENSIONS (2)
  ok   /opt/shared/node_modules/pi-extra/dist/index.js

skills: 清单 80 · 实测 80

verdict    OK
```

## What it checks

1. Every entry in `settings.json` `packages` resolves to an installed directory — `npm:name@ver`,
   `git:host/path@ref`, URLs, absolute paths, and relative paths (resolved from the settings file,
   as Pi does).
2. How many skills each package contributes, from its own `package.json` `pi.skills` manifest, the
   `{"source": …, "skills": []}` object form, and conventional `skills/` directories. Exclusions
   (`!` / `-`), forced includes (`+`), and glob roots are honoured. `"skills": []` means **no
   skills**, not "no filter".
3. How many skills Pi actually loads, by starting the real Pi CLI in RPC mode and asking it
   (`get_commands`; no model call). **Fewer loaded than declared is a failure** — that is the
   silent half-load this tool exists for.
4. Every path Lody injects through `LODY_PI_EXTENSIONS` still exists.
5. Drift against a baseline file: added or removed packages, version changes, skills that entered
   or left the prompt.

It is **not** a package manager, a linter for what a skill says, or a replacement for `pi list`.
It never edits `settings.json`.

## Relevance to Lody

A Lody Pi session loads resources through two independent channels:

| Channel | Supplies | Visible in the desktop UI |
|---|---|---|
| `LODY_PI_EXTENSIONS` (passed as `-e …`) | extension code: tools, hooks, prompt sections | extension picker |
| `settings.json` → `packages` | skills, prompts, themes | not in the picker; only the `$`-mention menu is blind to it |

A package that exists in only one channel loads half of itself. The failure is silent by design:
Pi warns about a package it cannot install and keeps running, and a `skills: []` filter looks like
a healthy install from the outside. That is why a checker outside the harness is useful, and why
the check has to compare *declared* against *loaded* instead of reading files only.

## Prerequisites

- Node.js 20 or newer.
- Inside a Lody Pi session, `PI_CODING_AGENT_DIR` is already set to that profile. **Outside one
  it is not**, and pointing the checker at the wrong directory would produce a confident wrong
  answer, so the tool refuses to guess: pass `--agents-dir <dir>`, or `--default-dir` for the
  terminal Pi profile (`~/.pi/agent`).
- The Pi CLI for the measurement step. It is discovered from `~/.lody/agent-binaries/pi/*` by
  highest version; override with `PI_CLI` or `--pi-cli`. Without it, use `--no-measure` (or
  `--measure-json`) and the declared counts are checked on their own.

## Usage

```sh
node bin/pi-profile-check.mjs                     # inside a Lody Pi session
PI_CODING_AGENT_DIR=<agentDir> node bin/pi-profile-check.mjs
node bin/pi-profile-check.mjs --default-dir       # terminal Pi profile

node bin/pi-profile-check.mjs --update-baseline   # accept the current state as the baseline
node bin/pi-profile-check.mjs --drift-ok          # print drift, still exit 0
node bin/pi-profile-check.mjs --no-measure        # skip the Pi measurement
node bin/pi-profile-check.mjs --json              # machine-readable
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | clean |
| `1` | problems: a package is missing, a pinned version does not match, fewer skills load than are declared, an injected extension path is gone |
| `3` | drift only: the profile differs from the baseline, but nothing is broken |
| `2` | usage error, including "no agent directory given" |

Problems always win over drift. `3` exists so CI can tell "look at the baseline" from "this is
broken": after `pi update` or a package change the profile is expected to drift, and failing it
with the same code as a broken install trains people to ignore the check.

## Verification

The comparison that matters is *fewer loaded than declared*. Reproduce it without installing
anything:

```sh
mkdir -p <tmp>/agent <tmp>/pkg/skills/one
printf '{"name":"p","version":"1.0.0","pi":{"skills":["./skills"]}}' > <tmp>/pkg/package.json
printf -- '---\nname: one\ndescription: "test"\n---\n' > <tmp>/pkg/skills/one/SKILL.md

# declared 1, loaded 0 -> problem, exit 1
printf '{"packages":["<tmp>/pkg"]}' > <tmp>/agent/settings.json
printf '{"skills":[]}' > <tmp>/measured.json
PI_CODING_AGENT_DIR=<tmp>/agent node bin/pi-profile-check.mjs \
  --baseline /dev/null --measure-json <tmp>/measured.json
```

The repository's own suite covers the same ground, plus git sources, relative paths, the object
form, drift and exit-code plumbing:

```sh
sh test/run-tests.sh                    # 11 cases; the real-CLI case is skipped without Pi
```

## Limitations

- **User-level settings only.** `settings.json` next to the agent directory is read. A project
  `.pi/settings.json` is not loaded, because Pi only honours it after project trust is granted.
- **Local entries are reported, not counted.** `settings.skills` / `settings.extensions` appear as a
  note; they change what Pi loads, so a mismatch they cause shows up as "loaded more than declared",
  never as a failure.
- **Approximate file reading.** The per-package skill count walks declared roots. Glob roots are
  expanded; anything Pi's loader does beyond that (validation, ordering) is only visible in the
  measured number.
- **Two Lody internals.** `LODY_PI_EXTENSIONS` and the `~/.lody/agent-binaries/pi/*` layout belong
  to Lody's bundled runtime, not to public Pi documentation. If either changes, this needs a patch.
  This is an unofficial tool; it is not affiliated with Lody or with Pi.
- The baseline file contains absolute paths. Keep it out of version control (`--baseline` takes a
  path; the default lives next to `settings.json`).

## License

MIT.
