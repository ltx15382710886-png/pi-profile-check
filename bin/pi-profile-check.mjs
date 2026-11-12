#!/usr/bin/env node
/**
 * Verify a Pi agent profile: settings.json `packages` are the single source of truth.
 *
 * Checks, in order:
 *   1. every declared package resolves to an installed directory (npm / git / local)
 *   2. the skills each package contributes, from its own `pi` manifest or `{skills: [...]}`
 *   3. the skills Pi actually loads, measured by running the real CLI (RPC get_commands)
 *   4. the extensions Lody injects by path (LODY_PI_EXTENSIONS) still exist
 *   5. drift against a baseline (added / removed skills, package add/remove, version bumps)
 *
 * Exit codes: 0 clean, 1 problems, 3 drift only (baseline differs, nothing broken),
 * 2 usage error. Pass --drift-ok to make drift exit 0 as well.
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, relative, sep, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";

const USAGE = `usage: pi-profile-check [options]

  --agents-dir <dir>   agent directory. Falls back to $PI_CODING_AGENT_DIR (set by Lody
                       inside its Pi sessions). No silent ~/.pi/agent default: a checker
                       that guesses checks the wrong profile and still says OK.
  --default-dir        explicitly use ~/.pi/agent (the terminal Pi profile)
  --pi-cli <path>      Pi CLI entry (default: $PI_CLI, else newest version under
                       ~/.lody/agent-binaries/pi)
  --baseline <file>    baseline file (default: <agents-dir>/pi-profile-baseline.json)
  --update-baseline    rewrite the baseline from this run (use after an intended change)
  --drift-ok           drift against the baseline does not fail (still printed)
  --no-measure         skip the RPC measurement (offline / fast)
  --measure-json <f>   read {"skills": [...]} from a file instead of running Pi.
                       Test seam: lets the measurement comparison be asserted without a
                       Pi install, and without depending on Pi's loader quirks.
  --json               machine-readable output`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--update-baseline") { out.updateBaseline = true; continue; }
    if (a === "--drift-ok") { out.driftOk = true; continue; }
    if (a === "--no-measure") { out.noMeasure = true; continue; }
    if (a === "--json") { out.json = true; continue; }
    if (a === "--default-dir") { out.defaultDir = true; continue; }
    const key = a.replace(/^--/, "");
    const value = argv[++i];
    if (value === undefined) usage(`missing value for ${a}`);
    out[key] = value;
  }
  return out;
}

function usage(message) {
  process.stderr.write(`pi-profile-check: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

function pickAgentsDir() {
  if (args["agents-dir"]) return { dir: resolve(args["agents-dir"]), explicit: true };
  if (process.env.PI_CODING_AGENT_DIR) return { dir: resolve(process.env.PI_CODING_AGENT_DIR), explicit: true, fromEnv: true };
  if (args.defaultDir) return { dir: join(homedir(), ".pi", "agent"), explicit: true, fromDefault: true };
  usage(
    "no agent directory. Set PI_CODING_AGENT_DIR (Lody sets it inside its Pi sessions), " +
      "pass --agents-dir <dir>, or pass --default-dir for the terminal Pi profile (~/.pi/agent)",
  );
}

const picked = pickAgentsDir();
const agentsDir = picked.dir;
const settingsPath = join(agentsDir, "settings.json");
const baselinePath = resolve(args.baseline ?? join(agentsDir, "pi-profile-baseline.json"));

const problems = [];
const notes = [];

/* ---------- source resolution ---------- */

const GIT_URL = /^(?:git:)?(?:https?:\/\/|git@|ssh:\/\/)?([^/\s]+)\/(.+?)(?:@([^@]+))?$/;

/** Settings sources: `npm:name@ver`, `git:host/path@ref`, a URL, or a (relative) path. */
function resolvePackage(source, settingsDir) {
  if (typeof source === "object" && source !== null) {
    const filter = { skills: source.skills, extensions: source.extensions };
    return { ...resolvePackage(source.source ?? "", settingsDir), filter };
  }
  if (typeof source !== "string" || source.trim() === "") {
    return { source: String(source), error: "空声明" };
  }
  const raw = source.trim();

  if (raw.startsWith("npm:")) {
    const spec = raw.slice(4).trim();
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : undefined;
    return { kind: "npm", source: raw, name, requested: version, dir: join(agentsDir, "npm", "node_modules", name) };
  }

  if (raw.startsWith("git:") || /^(https?:\/\/|git@|ssh:\/\/)/.test(raw)) {
    // pi installs user-scope git sources under <agentDir>/git/<host>/<path>
    const body = raw.replace(/^git:/, "");
    const parsed = GIT_URL.exec(body);
    if (!parsed) return { kind: "git", source: raw, unverifiable: "无法解析 git 源" };
    const [, host, path, ref] = parsed;
    return {
      kind: "git",
      source: raw,
      name: path,
      requested: ref,
      dir: join(agentsDir, "git", host, path.replace(/\.git$/, "")),
    };
  }

  // local path: relative paths resolve from the settings file that declares them
  const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  const dir = isAbsolute(expanded) ? resolve(expanded) : resolve(settingsDir, expanded);
  return { kind: "local", source: raw, name: dir.split(sep).pop(), dir };
}

/* ---------- skills a package declares ---------- */

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") { out += ".*"; i++; }
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function walkSkillDirs(root) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === "SKILL.md" && (e.isFile() || e.isSymbolicLink()))) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) visit(join(dir, entry.name));
    }
  };
  visit(root);
  return found;
}

/**
 * Skills a package contributes. Semantics that matter:
 *   - object form `{skills: []}` means "load none", not "no filter"
 *   - `!pattern` / `-pattern` exclude, `+pattern` force-includes
 *   - no declaration at all falls back to a conventional ./skills directory
 */
function packageSkills(pkgDir, filter) {
  const manifest = readManifest(pkgDir);
  const declared =
    filter && Object.prototype.hasOwnProperty.call(filter, "skills")
      ? filter.skills
      : manifest?.pi?.skills;
  const hasDeclaration = Array.isArray(declared);
  const patterns = hasDeclaration ? declared : existsSync(join(pkgDir, "skills")) ? ["./skills"] : [];

  const norm = (p) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const includes = patterns.filter((p) => !/^[!-]/.test(p)).map(norm);
  const excludes = patterns.filter((p) => /^[!-]/.test(p)).map((p) => norm(p.slice(1)));
  const forced = patterns.filter((p) => p.startsWith("+")).map((p) => norm(p.slice(1)));
  const forcedOut = patterns.filter((p) => p.startsWith("-")).map((p) => norm(p.slice(1)));

  if (hasDeclaration && includes.length === 0 && forced.length === 0) {
    return { names: [], manifest, declaredNone: true };
  }

  const excluded = (relDir, relFile) =>
    [relDir, relFile].some((v) =>
      excludes.some((x) => v === x || v.startsWith(`${x}/`)) ||
      forcedOut.some((x) => v === x || v.startsWith(`${x}/`)),
    );

  const names = new Set();
  const collect = (absRoot) => {
    for (const dir of walkSkillDirs(absRoot)) {
      const relDir = relative(pkgDir, dir).split(sep).join("/");
      if (excluded(relDir, `${relDir}/SKILL.md`)) continue;
      names.add(relDir.split("/").pop());
    }
  };

  for (const pattern of includes) {
    if (/[*?]/.test(pattern)) {
      const rx = globToRegExp(pattern);
      const base = pattern.split("/").slice(0, -1).join("/") || ".";
      const absBase = resolve(pkgDir, base);
      let matched = 0;
      for (const dir of walkSkillDirs(absBase)) {
        const relDir = relative(pkgDir, dir).split(sep).join("/");
        if (!rx.test(relDir) && !rx.test(`${relDir}/SKILL.md`)) continue;
        matched++;
        if (!excluded(relDir, `${relDir}/SKILL.md`)) names.add(relDir.split("/").pop());
      }
      if (matched === 0) notes.push(`${pkgDir}: glob skill root "${pattern}" matched nothing`);
    } else {
      collect(resolve(pkgDir, pattern));
    }
  }
  for (const pattern of forced) collect(resolve(pkgDir, pattern));

  return { names: [...names].sort(), manifest };
}

/* ---------- extensions injected by Lody ---------- */

function checkExtensions() {
  const raw = process.env.LODY_PI_EXTENSIONS;
  if (!raw) {
    notes.push("LODY_PI_EXTENSIONS 未设置：当前不在 Lody pi 会话里，跳过扩展通道检查");
    return [];
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    problems.push("LODY_PI_EXTENSIONS 不是合法 JSON");
    return [];
  }
  const rows = list.map((p) => ({ path: p, exists: existsSync(p) }));
  for (const row of rows) if (!row.exists) problems.push(`扩展路径不存在：${row.path}`);
  return rows;
}

/* ---------- Pi CLI ---------- */

function versionOf(cliPath) {
  try {
    return JSON.parse(readFileSync(join(dirname(cliPath), "..", "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function compareSemver(a, b) {
  const pa = String(a ?? "0").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? "0").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function findCli() {
  if (args["pi-cli"]) return { path: resolve(args["pi-cli"]), source: "--pi-cli" };
  if (process.env.PI_CLI) return { path: resolve(process.env.PI_CLI), source: "PI_CLI" };
  const base = join(homedir(), ".lody", "agent-binaries", "pi");
  if (!existsSync(base)) return undefined;
  const candidates = readdirSync(base)
    .map((v) => join(base, v, "node/package/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p, version: versionOf(p), mtime: statSync(p).mtimeMs }))
    // npm archives normalize mtimes to epoch, so version decides; mtime only breaks ties
    .sort((a, b) => compareSemver(b.version, a.version) || b.mtime - a.mtime);
  return candidates[0] ? { ...candidates[0], source: "agent-binaries (max version)" } : undefined;
}

/** Ground truth: what Pi actually loads, asked over RPC (no model call). */
function measuredSkills(cliPath) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--no-session", "--no-extensions"], {
      cwd: tmpdir(),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentsDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish({ error: "RPC 超时（25s）" }), 25000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("{")) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "response" && event.command === "get_commands") {
          const skills = (event.data?.commands ?? [])
            .map((c) => c.name)
            .filter((n) => typeof n === "string" && n.startsWith("skill:"))
            .map((n) => n.slice("skill:".length));
          finish({ skills });
        }
      }
    });
    child.once("error", (error) => finish({ error: error.message }));
    child.once("exit", () => finish({ error: "Pi 在应答前退出" }));
    child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "req1" })}\n`);
  });
}

/* ---------- run ---------- */

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
if (!existsSync(settingsPath)) problems.push(`找不到 ${settingsPath}`);

const settingsDir = dirname(settingsPath);
// Local entries in the same file are not packages; they still change what Pi loads.
for (const key of ["skills", "extensions"]) {
  const list = settings[key];
  if (Array.isArray(list) && list.length > 0) {
    notes.push(`settings.${key} 有 ${list.length} 条本地条目（不累加进清单，只影响实测）：${list.join(", ")}`);
  }
}
const declared = (settings.packages ?? []).map((entry) => resolvePackage(entry, settingsDir));
const rows = [];
let declaredSkills = 0;

for (const pkg of declared) {
  const row = { source: pkg.source, kind: pkg.kind, dir: pkg.dir, version: undefined, skills: [], missing: false };
  if (pkg.error) {
    row.missing = true;
    problems.push(`${pkg.source}：${pkg.error}`);
    rows.push(row);
    continue;
  }
  if (pkg.unverifiable) {
    row.unverifiable = pkg.unverifiable;
    notes.push(`${pkg.source}：${pkg.unverifiable}，未校验`);
    rows.push(row);
    continue;
  }
  if (!pkg.dir || !existsSync(pkg.dir)) {
    row.missing = true;
    problems.push(`未安装：${pkg.source}（期望在 ${pkg.dir ?? "?"}）`);
    rows.push(row);
    continue;
  }
  const { names, manifest, declaredNone } = packageSkills(pkg.dir, pkg.filter);
  row.version = manifest?.version;
  row.skills = names;
  row.declaredNone = declaredNone === true;
  declaredSkills += names.length;
  if (pkg.requested && row.version && pkg.requested !== row.version) {
    problems.push(`版本不符：${pkg.source} 要求 ${pkg.requested}，实际 ${row.version}`);
  }
  if (pkg.requested && row.version && pkg.requested === row.version) row.version = `${row.version} (pinned)`;
  rows.push(row);
}

const extensionRows = checkExtensions();

const result = {
  agentsDir,
  agentsDirSource: picked.fromEnv ? "PI_CODING_AGENT_DIR" : picked.fromDefault ? "--default-dir" : "--agents-dir",
  settingsPath,
  packages: rows,
  extensions: extensionRows,
  declaredSkills,
  measured: undefined,
  cli: undefined,
  baselinePath,
  drift: [],
  problems,
  notes,
};

const cli = findCli();
if (args["measure-json"]) {
  try {
    const injected = JSON.parse(readFileSync(resolve(args["measure-json"]), "utf8"));
    result.measured = (injected.skills ?? []).length;
    result.measuredSkills = injected.skills ?? [];
    result.cli = { path: "(injected)", version: undefined, source: "--measure-json" };
  } catch (error) {
    problems.push(`--measure-json 读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
} else if (!args.noMeasure) {
  if (!cli) {
    notes.push("找不到 Pi CLI：跳过实测（可用 --pi-cli 指定）");
  } else {
    result.cli = { path: cli.path, version: cli.version, source: cli.source };
    const measured = await measuredSkills(cli.path);
    if (measured.error) {
      notes.push(`实测失败：${measured.error}`);
    } else {
      result.measured = measured.skills.length;
      result.measuredSkills = measured.skills;
    }
  }
}

// the failure this tool exists for looks exactly like this: fewer loaded than declared
if (result.measured !== undefined) {
  if (result.measured < declaredSkills) {
    problems.push(
      `实测 ${result.measured} 个 skill，少于清单累加的 ${declaredSkills} 个：有包声明了 skill 却没加载（skills: [] 或排除项）`,
    );
  } else if (result.measured > declaredSkills) {
    notes.push(`实测 ${result.measured} 个 skill，多于清单累加的 ${declaredSkills} 个（glob 根、本地条目或内置 skill）`);
  }
}

const current = {
  packages: Object.fromEntries(rows.map((r) => [r.source, r.version ?? null])),
  skills: result.measuredSkills ?? rows.flatMap((r) => r.skills),
};

if (args.updateBaseline) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  notes.push(`已写入基线：${baselinePath}`);
} else if (existsSync(baselinePath)) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    baseline = undefined;
  }
  if (baseline === undefined || typeof baseline !== "object" || baseline === null) {
    notes.push(`基线不可读或为空，忽略：${baselinePath}`);
  } else {
    const before = new Set(baseline.skills ?? []);
    const after = new Set(current.skills ?? []);
    for (const name of [...after].filter((s) => !before.has(s)).sort()) result.drift.push(`+ skill ${name}`);
    for (const name of [...before].filter((s) => !after.has(s)).sort()) result.drift.push(`- skill ${name}`);
    for (const [source, version] of Object.entries(current.packages)) {
      const was = baseline.packages?.[source];
      if (was === undefined) result.drift.push(`+ package ${source}${version ? ` (${version})` : ""}`);
      else if (was !== version) result.drift.push(`~ ${source}: ${was} → ${version}`);
    }
    for (const source of Object.keys(baseline.packages ?? {})) {
      if (!(source in current.packages)) result.drift.push(`- package ${source}`);
    }
  }
} else {
  notes.push(`还没有基线，用 --update-baseline 记录本次状态到 ${baselinePath}`);
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const lines = [];
  lines.push(`agent dir  ${agentsDir}   (${result.agentsDirSource})`);
  lines.push(`settings   ${settingsPath}`);
  if (result.cli) lines.push(`pi cli     ${result.cli.path}   v${result.cli.version ?? "?"} (${result.cli.source})`);
  lines.push("");
  lines.push(`packages (${rows.length})`);
  for (const row of rows) {
    if (row.unverifiable) {
      lines.push(`  ${row.source}`);
      lines.push(`    ${row.unverifiable} — 未校验`);
      continue;
    }
    const state = row.missing ? "MISSING" : row.version ?? "?";
    lines.push(`  ${row.source}`);
    lines.push(
      `    → ${row.dir ?? "?"}  [${state}]  ${row.skills.length} skills${row.declaredNone ? "  (declared none)" : ""}`,
    );
  }
  if (extensionRows.length) {
    lines.push("");
    lines.push(`extensions via LODY_PI_EXTENSIONS (${extensionRows.length})`);
    for (const row of extensionRows) lines.push(`  ${row.exists ? "ok  " : "MISS"} ${row.path}`);
  }
  lines.push("");
  lines.push(`skills: 清单 ${declaredSkills}` + (result.measured === undefined ? "" : ` · 实测 ${result.measured}`));
  if (result.drift.length) {
    lines.push("");
    lines.push("drift vs baseline");
    for (const item of result.drift) lines.push(`  ${item}`);
  }
  for (const note of notes) lines.push(`note: ${note}`);
  if (problems.length) {
    lines.push("");
    lines.push("problems");
    for (const problem of problems) lines.push(`  ${problem}`);
  }
  lines.push(`\nverdict    ${problems.length ? `FAIL (${problems.length} problem${problems.length > 1 ? "s" : ""})` : result.drift.length ? `DRIFT (${result.drift.length} change${result.drift.length > 1 ? "s" : ""} vs baseline)` : "OK"}`);
  if (args.updateBaseline) lines.push("baseline   rewritten");
  process.stdout.write(`${lines.join("\n")}\n`);
}

// problems always fail; drift is its own code so CI can tell "broken" from "changed"
const exitCode = problems.length ? 1 : result.drift.length ? (args.driftOk ? 0 : 3) : 0;
process.exit(exitCode);
