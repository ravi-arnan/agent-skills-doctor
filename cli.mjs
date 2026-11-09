#!/usr/bin/env node
// skills-doctor: one read-only pass over every agent skills root on the machine.
//
// It answers the question harness.mjs doctor does not: what is wrong with the
// skills install. Four checks, each one a thing that otherwise fails silently:
//
//   invalid    a skill the harness skips (bad name, name != directory, no
//              description). Command Code loads none of these and says nothing.
//   broken     a symlinked skill whose target is gone.
//   duplicate  the same skill in several roots. Reported as `linked` (one
//              directory reached through a symlink, harmless), `identical`
//              (redundant copies) or `drift` (copies that have diverged).
//   catalog    the token cost of the skills Command Code actually loads every
//              session, with shadowed duplicates named.
//
// Nothing is written. Exit 0 when clean, 1 when there is something to fix.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HOME = process.env.HOME || homedir();

// Command Code walks up to 10 levels looking for a SKILL.md.
const MAX_DEPTH = 10;

// Global roots, one entry per agent. Agents that share `.agents/skills` are
// listed once under the path they actually read.
const GLOBAL_ROOTS = [
  ['command-code', '~/.commandcode/skills'],
  ['agents', '~/.agents/skills'],
  ['claude-code', '~/.claude/skills'],
  ['opencode', '~/.config/opencode/skills'],
  ['codex', '~/.codex/skills'],
  ['cursor', '~/.cursor/skills'],
  ['cline', '~/.cline/skills'],
  ['kiro', '~/.kiro/skills'],
  ['copilot', '~/.copilot/skills'],
  ['windsurf', '~/.codeium/windsurf/skills'],
  ['roo', '~/.roo/skills'],
  ['continue', '~/.continue/skills'],
  ['augment', '~/.augment/skills'],
  ['gemini-cli', '~/.gemini/skills'],
  ['antigravity', '~/.gemini/config/skills'],
  ['qwen-code', '~/.qwen/skills'],
];

// Project roots, resolved against the project directory.
const PROJECT_ROOTS = [
  ['command-code', '.commandcode/skills'],
  ['agents', '.agents/skills'],
  ['claude-code', '.claude/skills'],
  ['opencode', '.config/opencode/skills'],
  ['codex', '.codex/skills'],
  ['cursor', '.cursor/skills'],
  ['cline', '.cline/skills'],
  ['kiro', '.kiro/skills'],
  ['copilot', '.github/skills'],
  ['windsurf', '.windsurf/skills'],
  ['roo', '.roo/skills'],
  ['continue', '.continue/skills'],
  ['augment', '.augment/skills'],
  ['repo', 'skills'],
];

// The four locations Command Code loads, highest precedence first. This is the
// catalog that costs context on every turn, so it gets its own number.
const CMD_ROOTS = [
  ['command-code-project', '.commandcode/skills'],
  ['agents-project', '.agents/skills'],
  ['command-code-user', '~/.commandcode/skills'],
  ['agents-user', '~/.agents/skills'],
];

// ------------------------------------------------------------------ helpers

function expand(path, project) {
  if (path.startsWith('~')) return join(HOME, path.slice(1).replace(/^\//, ''));
  return isAbsolute(path) ? path : join(project, path);
}

const hash = (text) => createHash('sha256').update(text.trimEnd()).digest('hex');

// Only `name` and `description` are read; a full YAML parser is not worth it
// here. Values are unquoted so `name: "foo"` and `name: foo` behave the same.
export function parseFrontmatter(text) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
  if (!block) return {};
  const field = (key) => {
    const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(block[1]);
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  };
  return { name: field('name'), description: field('description') };
}

// The rules Command Code enforces before a skill is allowed to load.
export function validate(name, dirName, description) {
  const problems = [];
  if (!name) {
    problems.push('no name in frontmatter');
  } else {
    if (name !== dirName) problems.push(`name "${name}" does not match directory "${dirName}"`);
    if (!/^[a-z0-9-]+$/.test(name)) problems.push('name must be lowercase letters, digits and hyphens');
    if (name.length > 64) problems.push('name is longer than 64 characters');
    if (name.startsWith('-') || name.endsWith('-')) problems.push('name must not start or end with a hyphen');
    if (name.includes('--')) problems.push('name must not contain consecutive hyphens');
  }
  if (!description) problems.push('missing description');
  else if (description.length > 1024) problems.push('description is longer than 1024 characters');
  return problems;
}

function findSkillFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => /^skill\.md$/i.test(n));
  if (!hit) return null;
  try {
    return statSync(join(dir, hit)).isFile() ? hit : null;
  } catch {
    return null;
  }
}

function loadSkill(dir, file) {
  let text = '';
  try {
    text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    text = '';
  }
  const { name = '', description = '' } = parseFrontmatter(text);
  const dirName = basename(dir);
  let linked = false;
  try {
    linked = lstatSync(dir).isSymbolicLink();
  } catch {
    linked = false;
  }
  return {
    name: name.trim() || dirName,
    declaredName: name.trim(),
    dir,
    path: join(dir, file),
    description: description.trim(),
    hash: hash(text),
    chars: name.trim().length + description.trim().length,
    linked,
    problems: validate(name.trim(), dirName, description.trim()),
  };
}

// Walk one root. A directory holding a SKILL.md is a skill and its subfolders
// are not descended into; anything else is a grouping folder. `seen` holds real
// paths so whole-directory symlinks into the same tree do not loop.
function walk(dir, depth, ctx) {
  if (depth > MAX_DEPTH) return;
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (ctx.seen.has(real)) return;
  ctx.seen.add(real);

  const file = findSkillFile(dir);
  if (file) {
    ctx.skills.push(loadSkill(dir, file));
    return;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let stats;
      try {
        stats = statSync(child);
      } catch {
        ctx.broken.push({ path: child, target: safeReadlink(child) });
        continue;
      }
      if (stats.isDirectory()) walk(child, depth + 1, ctx);
      continue;
    }
    if (entry.isDirectory()) walk(child, depth + 1, ctx);
  }
}

function safeReadlink(path) {
  try {
    return readlinkSync(path);
  } catch {
    return '?';
  }
}

function scanRoot({ label, rel, scope }, project) {
  const abs = expand(rel, project);
  const exists = existsSync(abs);
  const ctx = { seen: new Set(), skills: [], broken: [] };
  if (exists) walk(abs, 0, ctx);
  const realDirs = ctx.skills.filter((s) => !s.linked).length;
  return {
    label,
    rel,
    scope,
    abs,
    exists,
    skills: ctx.skills,
    broken: ctx.broken,
    realDirs,
    linkedDirs: ctx.skills.length - realDirs,
  };
}

// Same skill name in more than one root. `linked` means every copy resolves to
// one directory (a symlink fan-out, not real duplication); `identical` means
// separate copies with the same bytes; `drift` means they have diverged.
export function findDuplicates(roots) {
  const byName = new Map();
  for (const root of roots) {
    for (const skill of root.skills) {
      const list = byName.get(skill.name) || [];
      list.push({
        root: root.rel,
        label: root.label,
        path: skill.path || skill.dir,
        dir: skill.dir,
        hash: skill.hash,
        real: safeRealpath(skill.dir),
        linked: skill.linked,
      });
      byName.set(skill.name, list);
    }
  }
  const out = [];
  for (const [name, copies] of byName) {
    if (new Set(copies.map((c) => c.root)).size < 2) continue;
    const oneDir = new Set(copies.map((c) => c.real)).size === 1;
    const oneHash = new Set(copies.map((c) => c.hash)).size === 1;
    out.push({
      name,
      copies,
      status: oneDir ? 'linked' : oneHash ? 'identical' : 'drift',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Two roots can name the same directory (running from $HOME makes `./.claude/
// skills` and `~/.claude/skills` the same path, and a whole-directory symlink
// does the same from anywhere). Keep the first, drop the rest, so nothing is
// counted twice.
function uniqueRoots(roots, project) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const key = safeRealpath(expand(root.rel, project));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

// The catalog Command Code loads, deduped by precedence: project before user,
// and `.commandcode/` before `.agents/` at the same level. `includeUser` is off
// in tests so they never read the real home directory.
export function cmdCatalog(project, { includeUser = true } = {}) {
  const table = includeUser ? CMD_ROOTS : CMD_ROOTS.filter(([, rel]) => !rel.startsWith('~'));
  const roots = uniqueRoots(
    table.map(([label, rel]) => ({ label, rel, scope: 'cmd' })),
    project,
  ).map((root) => scanRoot(root, project));
  const winners = new Map();
  const shadowed = [];
  for (const root of roots) {
    for (const skill of root.skills) {
      if (winners.has(skill.name)) {
        shadowed.push({ name: skill.name, kept: winners.get(skill.name).root, dropped: root.rel });
        continue;
      }
      winners.set(skill.name, { skill, root: root.rel });
    }
  }
  const entries = [...winners.values()];
  const tokens = entries.reduce((sum, { skill }) => sum + Math.ceil(skill.chars / 4), 0);
  const topSkills = [...entries]
    .sort((a, b) => b.skill.chars - a.skill.chars)
    .map(({ skill, root }) => ({
      name: skill.name,
      root,
      chars: skill.chars,
      tokens: Math.ceil(skill.chars / 4),
    }));

  return {
    roots,
    count: entries.length,
    tokens,
    shadowed,
    topSkills,
    skills: entries.map(({ skill, root }) => ({
      name: skill.name,
      root,
      chars: skill.chars,
      invalid: skill.problems,
    })),
  };
}

export function applyFixes({ invalid = [], broken = [] } = {}) {
  const fixes = [];
  // 1. Rename mismatched skill directories if safe and target doesn't exist
  for (const s of invalid) {
    if (!s.name || s.problems.length > 1) continue;
    const isMismatch = s.problems[0]?.includes('does not match directory');
    if (!isMismatch) continue;
    const parent = dirname(s.dir);
    const targetDir = join(parent, s.name);
    if (!existsSync(targetDir)) {
      try {
        renameSync(s.dir, targetDir);
        fixes.push({ type: 'rename', from: s.dir, to: targetDir, name: s.name });
      } catch {}
    }
  }

  // 2. Remove broken dangling symlinks
  for (const b of broken) {
    try {
      if (lstatSync(b.path).isSymbolicLink()) {
        rmSync(b.path);
        fixes.push({ type: 'remove_broken', path: b.path });
      }
    } catch {}
  }

  return fixes;
}

export function audit(options = {}) {
  const project = options.project || process.cwd();
  const roots = uniqueRoots(
    [
      ...(options.includeGlobal === false ? [] : GLOBAL_ROOTS.map(([label, rel]) => ({ label, rel, scope: 'global' }))),
      ...(options.includeProject === false ? [] : PROJECT_ROOTS.map(([label, rel]) => ({ label, rel, scope: 'project' }))),
      ...(options.extraRoots || []).map((rel) => ({ label: 'custom', rel, scope: 'custom' })),
    ],
    project,
  );
  const scanned = roots.map((root) => scanRoot(root, project));
  const present = scanned.filter((root) => root.exists);
  const duplicates = findDuplicates(present);
  const cmd = cmdCatalog(project, { includeUser: options.includeGlobal !== false });
  const invalid = present.flatMap((root) =>
    root.skills.filter((s) => s.problems.length).map((s) => ({ root: root.rel, dir: s.dir, name: s.name, problems: s.problems })),
  );
  const broken = present.flatMap((root) => root.broken);

  if (options.fix) {
    const fixes = applyFixes({ invalid, broken });
    if (fixes.length) {
      const rescanned = audit({ ...options, fix: false });
      return { ...rescanned, fixes };
    }
  }

  let budget = null;
  if (typeof options.budget === 'number' && !isNaN(options.budget)) {
    budget = {
      limit: options.budget,
      tokens: cmd.tokens,
      exceeded: cmd.tokens > options.budget,
    };
  }

  return { project, scanned, duplicates, cmd, invalid, broken, budget, fixes: [], options };
}

// ------------------------------------------------------------------- report

function pct(tokens, window) {
  return `${((tokens / window) * 100).toFixed(1)}%`;
}

function groupByHash(copies) {
  const groups = new Map();
  for (const copy of copies) {
    const group = groups.get(copy.hash) || { hash: copy.hash, roots: [] };
    groups.set(copy.hash, { hash: copy.hash, roots: [...group.roots, copy.root] });
  }
  return [...groups.values()].sort((a, b) => b.roots.length - a.roots.length);
}

function report(result) {
  const lines = [];
  const scanned = result.scanned.filter((r) => r.exists);
  const absent = result.scanned.length - scanned.length;
  const drift = result.duplicates.filter((d) => d.status === 'drift');
  const identical = result.duplicates.filter((d) => d.status === 'identical');
  const linked = result.duplicates.filter((d) => d.status === 'linked');

  lines.push('skills-doctor');
  lines.push('');
  lines.push(`roots: ${scanned.length} present, ${absent} absent`);
  const widest = Math.max(...scanned.map((r) => r.rel.length), 10);
  for (const root of scanned.slice().sort((a, b) => b.skills.length - a.skills.length)) {
    if (!root.skills.length) continue;
    const detail = root.linkedDirs ? `${root.realDirs} dirs + ${root.linkedDirs} symlinks` : 'all dirs';
    lines.push(`  ${root.rel.padEnd(widest)}  ${String(root.skills.length).padStart(3)} skills  (${detail})`);
  }

  lines.push('');
  lines.push('Command Code catalog');
  for (const root of result.cmd.roots) {
    lines.push(`  ${root.exists ? `${root.skills.length} skills` : 'absent'}  ${root.rel}`);
  }
  lines.push(`  loads ${result.cmd.count} skills, ~${result.cmd.tokens} tokens of metadata (${pct(result.cmd.tokens, 200000)} of a 200k window)`);
  if (result.budget) {
    if (result.budget.exceeded) {
      lines.push(`  budget exceeded: ~${result.budget.tokens} tokens (limit: ${result.budget.limit})`);
    } else {
      lines.push(`  budget check: ~${result.budget.tokens} / ${result.budget.limit} tokens (within limit)`);
    }
  }

  if (result.cmd.shadowed.length) {
    lines.push(`  shadowed: ${result.cmd.shadowed.length}`);
    for (const s of result.cmd.shadowed) lines.push(`    ${s.name}: keeps ${s.kept}, drops ${s.dropped}`);
  }

  if (result.options?.top && result.cmd.topSkills?.length) {
    const n = Math.min(result.options.top, result.cmd.topSkills.length);
    lines.push('');
    lines.push(`top ${n} skills by metadata token cost:`);
    const namePad = Math.max(...result.cmd.topSkills.slice(0, n).map((s) => s.name.length), 10);
    for (let i = 0; i < n; i++) {
      const s = result.cmd.topSkills[i];
      lines.push(`  ${String(i + 1).padStart(2)}. ${s.name.padEnd(namePad)}  ~${String(s.tokens).padStart(4)} tokens (${s.chars} chars)`);
    }
  }

  if (result.fixes?.length) {
    lines.push('');
    lines.push(`fixes applied: ${result.fixes.length}`);
    for (const f of result.fixes) {
      if (f.type === 'rename') lines.push(`  renamed directory ${f.from} -> ${f.name}`);
      if (f.type === 'remove_broken') lines.push(`  removed broken symlink ${f.path}`);
    }
  }

  const issues = [];
  let count = 0;
  if (result.invalid.length) {
    count += result.invalid.length;
    issues.push(`invalid: ${result.invalid.length} skill(s) the harness skips`);
    for (const s of result.invalid) issues.push(`    ${s.dir}: ${s.problems.join('; ')}`);
  }
  if (result.broken.length) {
    count += result.broken.length;
    issues.push(`broken: ${result.broken.length} dangling symlink(s)`);
    for (const b of result.broken) issues.push(`    ${b.path} -> ${b.target}`);
  }
  if (drift.length) {
    count += drift.length;
    issues.push(`drift: ${drift.length} skill(s) have copies with different content`);
    for (const d of drift) {
      issues.push(`    ${d.name} (${d.copies.length} copies)`);
      for (const group of groupByHash(d.copies)) {
        issues.push(`      [${group.roots.length}] ${group.roots.join(', ')} (${group.hash.slice(0, 8)})`);
      }
    }
  }
  if (result.budget?.exceeded) {
    count++;
    issues.push(`budget: metadata token cost (~${result.budget.tokens}) exceeds limit (${result.budget.limit})`);
  }

  lines.push('');
  if (!count) {
    lines.push('skills-doctor: no problems found');
  } else {
    lines.push(`skills-doctor: ${count} problem(s)`);
    for (const issue of issues) lines.push(`  ${issue}`);
  }

  lines.push('');
  lines.push(`info: ${identical.length} skill(s) identical across roots, ${linked.length} reached through a symlink`);
  if (linked.length) lines.push(`  linked: ${linked.map((d) => d.name).join(', ')}`);

  return { text: lines.join('\n'), problems: issues };
}

// --------------------------------------------------------------------- main

function help() {
  return [
    'usage: skills-doctor [options]',
    '',
    'Health check, linter, and token auditor for agent skills across every harness root.',
    '',
    'Options:',
    '  --fix          automatically repair safe issues (rename mismatched folders, remove broken links)',
    '  --budget <n>   fail with exit code 1 if metadata exceeds token limit',
    '  --top <n>      display top N skills by metadata token cost',
    '  --json         machine-readable output',
    '  --project <dir> directory to resolve project roots against (default: cwd)',
    '  --no-global    skip user-level global roots',
    '  --no-project   skip project-level roots',
    '  --root <dir>   extra root to scan (repeatable)',
    '  -h, --help     show this help text',
    '',
    'exit: 0 clean, 1 problems found, 2 usage error',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { extraRoots: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--fix') options.fix = true;
    else if (arg === '--no-global') options.includeGlobal = false;
    else if (arg === '--no-project') options.includeProject = false;
    else if (arg === '--project') options.project = argv[++i];
    else if (arg === '--budget') options.budget = Number(argv[++i]);
    else if (arg === '--top') options.top = Number(argv[++i]);
    else if (arg === '--root') options.extraRoots.push(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    console.error(options.error);
    console.error(help());
    return 2;
  }
  if (options.help) {
    console.log(help());
    return 0;
  }

  const result = audit(options);
  let count =
    result.invalid.length +
    result.broken.length +
    result.duplicates.filter((d) => d.status === 'drift').length;
  if (result.budget?.exceeded) count++;

  if (options.json) {
    console.log(JSON.stringify({ ...result, problemCount: count }, null, 2));
  } else {
    console.log(report(result).text);
  }
  return count ? 1 : 0;
}

const invoked =
  process.argv[1] && safeRealpath(resolve(process.argv[1])) === safeRealpath(fileURLToPath(import.meta.url));
if (invoked) {
  process.exit(main(process.argv.slice(2)));
}
