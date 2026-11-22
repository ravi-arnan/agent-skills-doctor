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
  symlinkSync,
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

const VALID_HARNESSES = new Set([
  'all',
  ...GLOBAL_ROOTS.map(([label]) => label),
  ...PROJECT_ROOTS.map(([label]) => label),
]);

// ------------------------------------------------------------------ helpers

function expand(path, project) {
  if (path.startsWith('~')) return join(HOME, path.slice(1).replace(/^\//, ''));
  return isAbsolute(path) ? path : join(project, path);
}

const IGNORED_DIRS = new Set(['.git', 'node_modules']);

function walkSkillFiles(rootDir) {
  const files = new Map();
  const visited = new Set();
  let latestMtime = 0;

  function walkDir(dir, prefix) {
    const real = safeRealpath(dir);
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name === '.DS_Store') continue;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walkDir(full, rel);
      } else if (stats.isFile()) {
        try {
          files.set(rel, readFileSync(full));
          if (stats.mtimeMs > latestMtime) latestMtime = stats.mtimeMs;
        } catch {}
      }
    }
  }

  walkDir(rootDir, '');
  return { files, mtimeMs: latestMtime };
}

// Deterministic hash + latest mtime across the whole skill directory so drift
// catches changes in companion scripts/references as well as SKILL.md.
function hashSkillDir(rootDir) {
  const { files, mtimeMs } = walkSkillFiles(rootDir);
  const hasher = createHash('sha256');
  for (const [rel, buf] of files) {
    hasher.update(`${rel}\0`);
    hasher.update(buf);
  }
  return { hash: hasher.digest('hex'), mtimeMs };
}

// Only `name` and `description` are read; a full YAML parser is not worth it
// here. Supports single-line quoted/unquoted values as well as multi-line
// block scalars (`|`, `>`, `|-`, `>-`) and indented continuations.
export function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const block = /^---\s*\n([\s\S]*?)(?:\n)?---(?:\s*$|\s*\n)/.exec(normalized);
  if (!block) return {};
  const lines = block[1].split('\n');
  const fields = {};

  for (let i = 0; i < lines.length; i++) {
    const keyMatch = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!keyMatch) continue;
    const [, key, rawVal] = keyMatch;
    if (key !== 'name' && key !== 'description') continue;

    const val = rawVal.trim();
    const blockMatch = /^([|>])([+-])?\d*$/.exec(val);
    if (blockMatch || val === '') {
      const style = blockMatch ? blockMatch[1] : 'plain';
      const chomp = blockMatch ? blockMatch[2] || '' : '';
      const collected = [];
      let baseIndent = null;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === '') {
          collected.push('');
          i++;
          continue;
        }
        const indentMatch = /^([ \t]+)(.*)$/.exec(next);
        if (!indentMatch) break;
        const indentLen = indentMatch[1].length;
        if (baseIndent === null) baseIndent = indentLen;
        collected.push(next.slice(Math.min(baseIndent, indentLen)));
        i++;
      }
      while (collected.length && collected[collected.length - 1] === '') {
        if (chomp === '+') break;
        collected.pop();
      }
      if (style === '|') {
        fields[key] = collected.join('\n');
      } else {
        const paragraphs = [];
        let current = [];
        for (const line of collected) {
          if (line === '') {
            if (current.length) {
              paragraphs.push(current.join(' '));
              current = [];
            }
          } else {
            current.push(line.trim());
          }
        }
        if (current.length) paragraphs.push(current.join(' '));
        fields[key] = paragraphs.join('\n');
      }
    } else {
      fields[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { name: fields.name || '', description: fields.description || '' };
}

// Scans SKILL.md body for relative links or companion script paths that do not exist on disk.
export function findMissingReferences(text, dir) {
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const missing = [];
  const seen = new Set();
  const isPlaceholder = (p) => /<.*?>|\[.*?\]|\.\.\/|\*|\?|path\/to|example\//i.test(p);

  // 1. Markdown links & image embeds: [text](path) or ![alt](path)
  const linkRegex = /(?:\[[^\]]*\]|!\[[^\]]*\])\((?!https?:\/\/|mailto:|tel:|data:|#|file:)([^)#\s]+)(?:#[^)]*)?\)/g;
  let m;
  while ((m = linkRegex.exec(clean)) !== null) {
    const rel = m[1].trim().replace(/^["']|["']$/g, '');
    if (!rel || isPlaceholder(rel)) continue;
    if (
      rel.startsWith('./') ||
      /^(?:scripts|references|reference|templates|resources|assets|examples)\//i.test(rel) ||
      /\.(?:md|sh|py|js|mjs|json|ya?ml|png|jpg|svg)$/i.test(rel)
    ) {
      const target = resolve(dir, rel);
      if (!existsSync(target) && !seen.has(rel)) {
        seen.add(rel);
        missing.push({ ref: rel, type: 'link' });
      }
    }
  }

  // 2. Scripts and explicit relative companion paths in backticks: `scripts/run.sh` or `./scripts/run.py`
  const codeRegex = /`(?:\.\/)?((?:scripts|references|reference|templates|resources|assets)\/[a-zA-Z0-9_.-]+)(?:\s+[^`]*)?`/g;
  while ((m = codeRegex.exec(clean)) !== null) {
    const lineStart = clean.lastIndexOf('\n', m.index) + 1;
    const lineEnd = clean.indexOf('\n', m.index);
    const lineText = clean.slice(lineStart, lineEnd === -1 ? clean.length : lineEnd);
    if (/^\s*(?:[-*]\s*)?(?:\*\*)?examples?(?:\*\*)?\s*:/i.test(lineText)) continue;

    const fullMatch = m[0];
    const rel = m[1].trim().replace(/[.,;:]+$/, '');
    if (!rel || isPlaceholder(rel)) continue;
    const isExplicitRel = fullMatch.startsWith('`./');
    const isScript = /^scripts\/[a-zA-Z0-9_.-]+\.(?:sh|py|js|mjs|bash|ts)$/i.test(rel);
    if (isExplicitRel || isScript) {
      const target = resolve(dir, rel);
      if (!existsSync(target) && !seen.has(rel)) {
        seen.add(rel);
        missing.push({ ref: rel, type: 'asset' });
      }
    }
  }

  return missing;
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
  const chars = name.trim().length + description.trim().length;
  const payloadChars = text.length;
  const dirDigest = hashSkillDir(dir);
  return {
    name: name.trim() || dirName,
    declaredName: name.trim(),
    dir,
    path: join(dir, file),
    description: description.trim(),
    hash: dirDigest.hash,
    mtimeMs: dirDigest.mtimeMs,
    chars,
    tokens: Math.ceil(chars / 4),
    payloadChars,
    payloadTokens: Math.ceil(payloadChars / 4),
    missing: findMissingReferences(text, dir),
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

// Same skill name in more than one directory (across roots or nested within the
// same root). `linked` means every copy resolves to one directory (a symlink
// fan-out, not real duplication); `identical` means separate copies with the
// same bytes; `drift` means they have diverged.
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
        mtimeMs: skill.mtimeMs || 0,
        real: safeRealpath(skill.dir),
        linked: skill.linked,
      });
      byName.set(skill.name, list);
    }
  }
  const out = [];
  for (const [name, copies] of byName) {
    if (new Set(copies.map((c) => c.dir)).size < 2) continue;
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

function buildCatalog(roots, harness = 'command-code') {
  const winners = new Map();
  const shadowed = [];
  for (const root of roots) {
    for (const skill of root.skills) {
      const real = safeRealpath(skill.dir);
      if (winners.has(skill.name)) {
        const winner = winners.get(skill.name);
        if (winner.real !== real) {
          shadowed.push({ name: skill.name, kept: winner.root, dropped: root.rel });
        }
        continue;
      }
      winners.set(skill.name, { skill, root: root.rel, real });
    }
  }
  const entries = [...winners.values()];
  const tokens = entries.reduce((sum, { skill }) => sum + skill.tokens, 0);
  const payloadTokens = entries.reduce((sum, { skill }) => sum + skill.payloadTokens, 0);
  const payloadChars = entries.reduce((sum, { skill }) => sum + skill.payloadChars, 0);
  const topSkills = [...entries].map(({ skill, root }) => ({
    name: skill.name,
    root,
    chars: skill.chars,
    tokens: skill.tokens,
    payloadChars: skill.payloadChars,
    payloadTokens: skill.payloadTokens,
  }));

  return {
    harness,
    roots,
    count: entries.length,
    tokens,
    payloadTokens,
    payloadChars,
    shadowed,
    topSkills,
    skills: entries.map(({ skill, root }) => ({
      name: skill.name,
      root,
      chars: skill.chars,
      tokens: skill.tokens,
      payloadChars: skill.payloadChars,
      payloadTokens: skill.payloadTokens,
      invalid: skill.problems,
      missing: skill.missing,
    })),
  };
}

// The catalog Command Code loads, deduped by precedence: project before user,
// and `.commandcode/` before `.agents/` at the same level. `includeUser` is off
// in tests so they never read the real home directory.
export function cmdCatalog(project, { includeUser = true, includeProject = true } = {}) {
  const table = CMD_ROOTS.filter(
    ([, rel]) => (includeUser || !rel.startsWith('~')) && (includeProject || rel.startsWith('~')),
  );
  const roots = uniqueRoots(
    table.map(([label, rel]) => ({ label, rel, scope: 'cmd' })),
    project,
  ).map((root) => scanRoot(root, project));
  return buildCatalog(roots, 'command-code');
}

function selectCatalog(harness, scanned, cmd) {
  const projectFirst = [...scanned].sort((a, b) => {
    const rank = (s) => (s === 'project' ? 0 : s === 'custom' ? 1 : 2);
    return rank(a.scope) - rank(b.scope);
  });

  if (harness === 'command-code') return cmd;
  if (harness === 'all') return buildCatalog(projectFirst, 'all');
  if (harness) {
    return buildCatalog(
      projectFirst.filter((r) => r.label === harness),
      harness,
    );
  }

  // Default: Command Code when present; otherwise auto-detect active harness(es)
  // so --budget and --top work out of the box for Claude Code, Cursor, etc.
  if (cmd.count > 0) return cmd;
  const activeLabels = [...new Set(projectFirst.filter((r) => r.skills.length > 0).map((r) => r.label))];
  if (activeLabels.length === 1) {
    const label = activeLabels[0];
    return buildCatalog(
      projectFirst.filter((r) => r.label === label),
      label,
    );
  }
  if (activeLabels.length > 1) return buildCatalog(projectFirst, 'all');
  return cmd;
}

export function applyFixes({ invalid = [], broken = [] } = {}) {
  const fixes = [];
  // 1. Rename mismatched skill directories if safe and target doesn't exist
  for (const s of invalid) {
    if (!s.name || s.problems.length > 1) continue;
    if (s.name.includes('/') || s.name.includes('\\') || s.name.includes('..')) continue;
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
  const ignored = new Set(options.ignore || []);
  const duplicates = findDuplicates(present).map((d) =>
    ignored.has(d.name) ? { ...d, ignored: true } : d,
  );
  const cmd = cmdCatalog(project, {
    includeUser: options.includeGlobal !== false,
    includeProject: options.includeProject !== false,
  });
  const catalog = selectCatalog(options.harness, scanned, cmd);
  const invalid = present.flatMap((root) =>
    root.skills
      .filter((s) => s.problems.length)
      .map((s) => ({ root: root.rel, dir: s.dir, name: s.name, problems: s.problems, ignored: ignored.has(s.name) })),
  );
  const broken = present.flatMap((root) => root.broken);
  const missing = present.flatMap((root) =>
    root.skills.flatMap((s) =>
      s.missing.map((m) => ({
        root: root.rel,
        dir: s.dir,
        name: s.name,
        ref: m.ref,
        type: m.type,
        ignored: ignored.has(s.name),
      })),
    ),
  );

  let fixes = [];
  if (options.fix) {
    fixes = applyFixes({ invalid: invalid.filter((s) => !s.ignored), broken });
    if (fixes.length) {
      const rescanned = audit({ ...options, fix: false });
      return { ...rescanned, fixes };
    }
  }

  let syncs = [];
  if (options.sync) {
    syncs = applySync(duplicates, { prefer: options.prefer, dryRun: options.dryRun, project });
    if (syncs.some((s) => s.action === 'linked') && !options.dryRun) {
      const rescanned = audit({ ...options, sync: false });
      return { ...rescanned, fixes, syncs };
    }
  }

  let budget = null;
  if (typeof options.budget === 'number' && !isNaN(options.budget)) {
    budget = {
      limit: options.budget,
      tokens: catalog.tokens,
      exceeded: catalog.tokens > options.budget,
    };
  }

  return { project, scanned, duplicates, cmd, catalog, invalid, broken, missing, budget, fixes, syncs, options };
}

export function applySync(duplicates, { prefer, dryRun = false, project = process.cwd() } = {}) {
  const syncs = [];
  const preferTarget = prefer ? safeRealpath(expand(prefer, project)) : null;

  for (const dup of duplicates) {
    if (dup.ignored || dup.status === 'linked') continue;
    const uniqueDirs = new Map();
    for (const c of dup.copies) {
      if (!uniqueDirs.has(c.real)) uniqueDirs.set(c.real, c);
    }
    if (uniqueDirs.size < 2) continue;

    const candidates = [...uniqueDirs.values()];
    let source = null;
    if (prefer) {
      source = dup.copies.find(
        (c) =>
          c.root === prefer ||
          c.label === prefer ||
          safeRealpath(expand(c.root, project)) === preferTarget,
      );
      if (!source) continue;
      source = uniqueDirs.get(source.real) || source;
    } else {
      candidates.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
      source = candidates[0];
    }

    for (const copy of dup.copies) {
      if (copy.real === source.real) continue;
      if (dryRun) {
        syncs.push({ action: 'would_link', name: dup.name, from: copy.dir, to: source.real });
        continue;
      }
      try {
        if (!existsSync(source.real)) {
          syncs.push({ action: 'error', name: dup.name, from: copy.dir, to: source.real, error: 'source directory no longer exists' });
          continue;
        }
        rmSync(copy.dir, { recursive: true, force: true });
        symlinkSync(source.real, copy.dir, 'dir');
        syncs.push({ action: 'linked', name: dup.name, from: copy.dir, to: source.real });
      } catch (err) {
        syncs.push({ action: 'error', name: dup.name, from: copy.dir, to: source.real, error: err.message });
      }
    }
  }
  return syncs;
}

function listSkillFiles(rootDir) {
  return walkSkillFiles(rootDir).files;
}

function previewTextDiff(bufA, bufB, maxLines = 10) {
  if (bufA.length > 65536 || bufB.length > 65536) return [];
  const aLines = bufA.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  const bLines = bufB.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const out = [];
  for (const line of aLines) {
    if (!bSet.has(line) && line.trim()) {
      out.push(`- ${line}`);
      if (out.length >= maxLines) break;
    }
  }
  for (const line of bLines) {
    if (!aSet.has(line) && line.trim()) {
      out.push(`+ ${line}`);
      if (out.length >= maxLines * 2) break;
    }
  }
  return out;
}

export function diffSkill(result, skillName) {
  const copies = [];
  for (const root of result.scanned) {
    if (!root.exists) continue;
    for (const s of root.skills) {
      if (s.name === skillName) {
        copies.push({ root: root.rel, dir: s.dir, hash: s.hash, mtimeMs: s.mtimeMs || 0, real: safeRealpath(s.dir) });
      }
    }
  }
  if (!copies.length) return { found: false, lines: [`skill "${skillName}" not found`] };
  const groups = groupByHash(copies);
  if (groups.length === 1) {
    const oneDir = new Set(copies.map((c) => c.real)).size === 1;
    const noun = copies.length === 1 ? 'copy' : 'copies';
    return {
      found: true,
      drifted: false,
      lines: [`${skillName}: ${copies.length} ${noun}, all ${oneDir ? 'linked to one directory' : 'identical'} (${groups[0].hash.slice(0, 8)})`],
    };
  }

  const base = groups[0];
  const baseCopy = copies.find((c) => c.hash === base.hash);
  const baseFiles = listSkillFiles(baseCopy.dir);
  const lines = [`${skillName} (${copies.length} copies, ${groups.length} variants)`];
  const baseDate = formatDate(base.mtimeMs);
  lines.push(`  base (newest): [${base.roots.length}] ${base.roots.join(', ')} (${base.hash.slice(0, 8)}${baseDate ? `, ${baseDate}` : ''})`);

  for (let i = 1; i < groups.length; i++) {
    const grp = groups[i];
    const grpCopy = copies.find((c) => c.hash === grp.hash);
    const grpFiles = listSkillFiles(grpCopy.dir);
    const grpDate = formatDate(grp.mtimeMs);
    lines.push(`  variant ${i}: [${grp.roots.length}] ${grp.roots.join(', ')} (${grp.hash.slice(0, 8)}${grpDate ? `, ${grpDate}` : ''})`);

    const allPaths = new Set([...baseFiles.keys(), ...grpFiles.keys()]);
    for (const rel of [...allPaths].sort()) {
      const a = grpFiles.get(rel);
      const b = baseFiles.get(rel);
      if (!a) lines.push(`    added in base: ${rel}`);
      else if (!b) lines.push(`    removed in base: ${rel}`);
      else if (!a.equals(b)) {
        lines.push(`    modified: ${rel}`);
        if (/\.(?:md|txt|sh|py|js|mjs|json|ya?ml)$/i.test(rel)) {
          for (const dLine of previewTextDiff(a, b)) lines.push(`      ${dLine}`);
        }
      }
    }
  }
  return { found: true, drifted: true, lines };
}

// ------------------------------------------------------------------- report

function pct(tokens, window) {
  return `${((tokens / window) * 100).toFixed(1)}%`;
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

function groupByHash(copies) {
  const groups = new Map();
  for (const copy of copies) {
    const group = groups.get(copy.hash) || { hash: copy.hash, roots: [], mtimeMs: 0 };
    groups.set(copy.hash, {
      hash: copy.hash,
      roots: [...group.roots, copy.root],
      mtimeMs: Math.max(group.mtimeMs, copy.mtimeMs || 0),
    });
  }
  return [...groups.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || b.roots.length - a.roots.length);
}

function report(result) {
  const lines = [];
  const scanned = result.scanned.filter((r) => r.exists);
  const absent = result.scanned.length - scanned.length;
  const drift = result.duplicates.filter((d) => d.status === 'drift' && !d.ignored);
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

  const catalog = result.catalog || result.cmd;
  const catalogTitle =
    catalog.harness === 'command-code' || !catalog.harness
      ? 'Command Code catalog'
      : catalog.harness === 'all'
        ? 'Skills catalog (all harnesses)'
        : `Skills catalog (${catalog.harness})`;
  const visibleRoots =
    catalog.harness === 'all' ? catalog.roots.filter((r) => r.exists) : catalog.roots;

  lines.push('');
  lines.push(catalogTitle);
  for (const root of visibleRoots) {
    lines.push(`  ${root.exists ? `${root.skills.length} skills` : 'absent'}  ${root.rel}`);
  }
  const avgPayload = catalog.count ? Math.round(catalog.payloadTokens / catalog.count) : 0;
  lines.push(
    `  loads ${catalog.count} skills: ~${catalog.tokens} tokens metadata (${pct(catalog.tokens, 200000)} of a 200k window) | ~${catalog.payloadTokens} tokens full payload (~${avgPayload} avg/skill)`,
  );
  if (result.budget) {
    if (result.budget.exceeded) {
      lines.push(`  budget exceeded: ~${result.budget.tokens} tokens (limit: ${result.budget.limit})`);
    } else {
      lines.push(`  budget check: ~${result.budget.tokens} / ${result.budget.limit} tokens (within limit)`);
    }
  }

  if (catalog.shadowed.length) {
    lines.push(`  shadowed: ${catalog.shadowed.length}`);
    for (const s of catalog.shadowed) lines.push(`    ${s.name}: keeps ${s.kept}, drops ${s.dropped}`);
  }

  if (result.options?.top && catalog.topSkills?.length) {
    const isPayload = result.options?.by === 'payload';
    const sorted = [...catalog.topSkills].sort((a, b) =>
      isPayload ? b.payloadTokens - a.payloadTokens : b.tokens - a.tokens,
    );
    const n = Math.min(result.options.top, sorted.length);
    lines.push('');
    lines.push(`top ${n} skills by ${isPayload ? 'activation payload' : 'catalog metadata'} token cost:`);
    const namePad = Math.max(...sorted.slice(0, n).map((s) => s.name.length), 10);
    for (let i = 0; i < n; i++) {
      const s = sorted[i];
      lines.push(
        `  ${String(i + 1).padStart(2)}. ${s.name.padEnd(namePad)}  ~${String(s.tokens).padStart(4)} metadata  |  ~${String(s.payloadTokens).padStart(5)} payload tokens (${s.payloadChars} chars)`,
      );
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

  if (result.syncs?.length) {
    const label = result.options?.dryRun ? 'sync preview (dry-run)' : 'sync applied';
    lines.push('');
    lines.push(`${label}: ${result.syncs.length}`);
    for (const s of result.syncs) {
      if (s.action === 'error') lines.push(`  error ${s.name}: ${s.from} -> ${s.to} (${s.error})`);
      else lines.push(`  ${s.name}: ${s.from} -> ${s.to}`);
    }
  }

  const invalid = result.invalid.filter((s) => !s.ignored);
  const missing = (result.missing || []).filter((m) => !m.ignored);

  const issues = [];
  let count = 0;
  if (invalid.length) {
    count += invalid.length;
    issues.push(`invalid: ${invalid.length} skill(s) the harness skips`);
    for (const s of invalid) issues.push(`    ${s.dir}: ${s.problems.join('; ')}`);
  }
  if (result.broken.length) {
    count += result.broken.length;
    issues.push(`broken: ${result.broken.length} dangling symlink(s)`);
    for (const b of result.broken) issues.push(`    ${b.path} -> ${b.target}`);
  }
  if (missing.length) {
    count += missing.length;
    issues.push(`missing: ${missing.length} referenced companion asset(s) not found on disk`);
    for (const m of missing) {
      const desc = m.type === 'link' ? 'broken markdown link' : 'missing script or companion file';
      issues.push(`    ${m.dir}: references "${m.ref}" (${desc})`);
    }
  }
  if (drift.length) {
    count += drift.length;
    issues.push(`drift: ${drift.length} skill(s) have copies with different content`);
    for (const d of drift) {
      issues.push(`    ${d.name} (${d.copies.length} copies)`);
      const groups = groupByHash(d.copies);
      const maxMtime = Math.max(...groups.map((g) => g.mtimeMs));
      const minMtime = Math.min(...groups.map((g) => g.mtimeMs));
      const showNewest = groups.length > 1 && maxMtime - minMtime > 1000;
      for (const group of groups) {
        const meta = [group.hash.slice(0, 8)];
        const date = formatDate(group.mtimeMs);
        if (date) meta.push(date);
        if (showNewest && group.mtimeMs === maxMtime) meta.push('newest');
        issues.push(`      [${group.roots.length}] ${group.roots.join(', ')} (${meta.join(', ')})`);
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
    '       skills-doctor diff <skill> [options]',
    '',
    'Health check, linter, and token auditor for agent skills across every harness root.',
    '',
    'Options:',
    '  --fix             automatically repair safe issues (rename mismatched folders, remove broken links)',
    '  --sync            replace duplicate/stale skill copies with symlinks to the newest or --prefer root',
    '  --prefer <root>   preferred source root for --sync (e.g. ~/.agents/skills or agents)',
    '  --dry-run         preview --sync changes without modifying files',
    '  --harness <name>  audit catalog/budget for a specific harness (e.g. claude-code, cursor, all)',
    '  --budget <n>      fail with exit code 1 if metadata exceeds token limit',
    '  --top <n>         display top N skills by token cost',
    '  --by <metric>     metric to sort top skills by: catalog (default) or payload',
    '  --json            machine-readable output',
    '  --project <dir>   directory to resolve project roots against (default: cwd)',
    '  --no-global       skip user-level global roots',
    '  --no-project      skip project-level roots',
    '  --root <dir>      extra root to scan (repeatable)',
    '  --ignore <name>   ignore drift/missing/invalid issues for a skill (repeatable)',
    '  -h, --help        show this help text',
    '',
    'Config:',
    '  Reads optional .skills-doctor.json from the project directory (CLI flags override).',
    '',
    'exit: 0 clean, 1 problems found, 2 usage error',
  ].join('\n');
}

export function loadConfig(project) {
  const cfgPath = join(project, '.skills-doctor.json');
  if (!existsSync(cfgPath)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    return { error: `invalid .skills-doctor.json: ${err.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'invalid .skills-doctor.json: expected a JSON object' };
  }
  const cfg = {};
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore) || raw.ignore.some((v) => typeof v !== 'string')) {
      return { error: 'invalid .skills-doctor.json: "ignore" must be an array of strings' };
    }
    cfg.ignore = raw.ignore;
  }
  if (raw.roots !== undefined) {
    if (!Array.isArray(raw.roots) || raw.roots.some((v) => typeof v !== 'string')) {
      return { error: 'invalid .skills-doctor.json: "roots" must be an array of strings' };
    }
    cfg.roots = raw.roots;
  }
  if (raw.budget !== undefined) {
    if (!Number.isInteger(raw.budget) || raw.budget < 0) {
      return { error: 'invalid .skills-doctor.json: "budget" must be a non-negative integer' };
    }
    cfg.budget = raw.budget;
  }
  if (raw.top !== undefined) {
    if (!Number.isInteger(raw.top) || raw.top < 1) {
      return { error: 'invalid .skills-doctor.json: "top" must be a positive integer' };
    }
    cfg.top = raw.top;
  }
  if (raw.by !== undefined) {
    if (raw.by !== 'catalog' && raw.by !== 'payload') {
      return { error: 'invalid .skills-doctor.json: "by" must be "catalog" or "payload"' };
    }
    cfg.by = raw.by;
  }
  if (raw.harness !== undefined) {
    if (typeof raw.harness !== 'string' || !VALID_HARNESSES.has(raw.harness)) {
      return { error: `invalid .skills-doctor.json: unknown harness "${raw.harness}"` };
    }
    cfg.harness = raw.harness;
  }
  if (raw.noGlobal !== undefined) {
    if (typeof raw.noGlobal !== 'boolean') {
      return { error: 'invalid .skills-doctor.json: "noGlobal" must be a boolean' };
    }
    cfg.noGlobal = raw.noGlobal;
  }
  if (raw.noProject !== undefined) {
    if (typeof raw.noProject !== 'boolean') {
      return { error: 'invalid .skills-doctor.json: "noProject" must be a boolean' };
    }
    cfg.noProject = raw.noProject;
  }
  return cfg;
}

function parseArgs(argv) {
  const options = { extraRoots: [], ignore: [] };
  const nextVal = (i, flag) => {
    const val = argv[i + 1];
    if (val === undefined || val === '' || val.startsWith('-')) {
      return { error: `missing value for ${flag}` };
    }
    return { val };
  };
  const nextInt = (i, flag, min) => {
    const raw = argv[i + 1];
    if (raw === undefined || raw === '') return { error: `missing value for ${flag}` };
    const num = Number(raw);
    if (!Number.isInteger(num) || num < min) {
      return { error: `invalid ${flag} value: ${raw} (expected integer >= ${min})` };
    }
    return { val: num };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'diff' && !options.command) {
      const target = argv[++i];
      if (!target || target.startsWith('-')) return { error: 'missing skill name for diff' };
      options.command = 'diff';
      options.targetSkill = target;
    }
    else if (arg === '--json') options.json = true;
    else if (arg === '--fix') options.fix = true;
    else if (arg === '--sync') options.sync = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--prefer') {
      const res = nextVal(i, '--prefer');
      if (res.error) return res;
      options.prefer = res.val;
      i++;
    }
    else if (arg === '--harness') {
      const res = nextVal(i, '--harness');
      if (res.error) return res;
      if (!VALID_HARNESSES.has(res.val)) {
        return { error: `unknown --harness value: ${res.val} (valid: ${[...VALID_HARNESSES].join(', ')})` };
      }
      options.harness = res.val;
      i++;
    }
    else if (arg === '--no-global') options.includeGlobal = false;
    else if (arg === '--no-project') options.includeProject = false;
    else if (arg === '--project') {
      const res = nextVal(i, '--project');
      if (res.error) return res;
      options.project = res.val;
      i++;
    }
    else if (arg === '--budget') {
      const res = nextInt(i, '--budget', 0);
      if (res.error) return res;
      options.budget = res.val;
      i++;
    }
    else if (arg === '--top') {
      const res = nextInt(i, '--top', 1);
      if (res.error) return res;
      options.top = res.val;
      i++;
    }
    else if (arg === '--by') {
      const res = nextVal(i, '--by');
      if (res.error) return res;
      if (res.val !== 'catalog' && res.val !== 'payload') {
        return { error: `invalid --by value: ${res.val} (expected "catalog" or "payload")` };
      }
      options.by = res.val;
      i++;
    }
    else if (arg === '--root') {
      const res = nextVal(i, '--root');
      if (res.error) return res;
      options.extraRoots.push(res.val);
      i++;
    }
    else if (arg === '--ignore') {
      const res = nextVal(i, '--ignore');
      if (res.error) return res;
      options.ignore.push(res.val);
      i++;
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  return options;
}

function mergeOptions(config, cli) {
  return {
    ...cli,
    ignore: [...new Set([...(config.ignore || []), ...cli.ignore])],
    extraRoots: [...new Set([...(config.roots || []), ...cli.extraRoots])],
    budget: cli.budget ?? config.budget,
    top: cli.top ?? config.top,
    by: cli.by ?? config.by,
    harness: cli.harness ?? config.harness,
    includeGlobal: cli.includeGlobal !== undefined ? cli.includeGlobal : config.noGlobal ? false : undefined,
    includeProject: cli.includeProject !== undefined ? cli.includeProject : config.noProject ? false : undefined,
  };
}

function main(argv) {
  const cliOptions = parseArgs(argv);
  if (cliOptions.error) {
    console.error(cliOptions.error);
    console.error(help());
    return 2;
  }
  if (cliOptions.help) {
    console.log(help());
    return 0;
  }

  const config = loadConfig(cliOptions.project || process.cwd());
  if (config.error) {
    console.error(config.error);
    return 2;
  }
  const options = mergeOptions(config, cliOptions);

  const result = audit(options);
  if (options.command === 'diff') {
    const d = diffSkill(result, options.targetSkill);
    if (options.json) console.log(JSON.stringify(d, null, 2));
    else console.log(d.lines.join('\n'));
    return d.found ? 0 : 1;
  }

  let count =
    result.invalid.filter((s) => !s.ignored).length +
    result.broken.length +
    (result.missing || []).filter((m) => !m.ignored).length +
    result.duplicates.filter((d) => d.status === 'drift' && !d.ignored).length;
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
