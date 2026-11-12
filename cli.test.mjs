import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { audit, findMissingReferences, parseFrontmatter, validate } from './cli.mjs';

function skill(dir, name, description) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

test('parseFrontmatter reads name and description and unquotes', () => {
  const fm = parseFrontmatter('---\nname: "foo"\ndescription: bar baz\n---\nbody');
  assert.equal(fm.name, 'foo');
  assert.equal(fm.description, 'bar baz');
});

test('validate flags a name that does not match its directory', () => {
  assert.deepEqual(validate('foo', 'foo--1234', 'x'), ['name "foo" does not match directory "foo--1234"']);
});

test('validate flags a missing description', () => {
  assert.ok(validate('foo', 'foo', '').includes('missing description'));
});

test('audit finds invalid skills, a broken link, identical copies and drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-'));
  try {
    skill(join(root, '.commandcode/skills/good'), 'good', 'a good skill');
    skill(join(root, '.agents/skills/good'), 'good', 'a good skill');
    skill(join(root, '.commandcode/skills/moved'), 'moved', 'one');
    skill(join(root, '.agents/skills/moved'), 'moved', 'two');
    skill(join(root, '.commandcode/skills/bad--abcd'), 'bad', 'x');
    symlinkSync(join(root, 'nope'), join(root, '.commandcode/skills/gone'));

    const result = audit({ project: root, includeGlobal: false });

    assert.equal(result.invalid.length, 1);
    assert.match(result.invalid[0].problems[0], /does not match directory/);
    assert.equal(result.broken.length, 1);

    const status = Object.fromEntries(result.duplicates.map((d) => [d.name, d.status]));
    assert.equal(status.good, 'identical');
    assert.equal(status.moved, 'drift');

    // The Command Code catalog dedupes by name: good, moved and bad.
    assert.equal(result.cmd.count, 3);
    assert.ok(result.cmd.tokens > 0);
    assert.deepEqual(result.cmd.shadowed.map((s) => s.name), ['good', 'moved']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit reports a clean tree as clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-clean-'));
  try {
    skill(join(root, '.commandcode/skills/only'), 'only', 'the only skill');
    const result = audit({ project: root, includeGlobal: false });
    assert.equal(result.invalid.length, 0);
    assert.equal(result.broken.length, 0);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.cmd.count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget flag detects when tokens exceed limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-budget-'));
  try {
    skill(join(root, '.commandcode/skills/heavy'), 'heavy', 'a'.repeat(200));
    const passResult = audit({ project: root, includeGlobal: false, budget: 1000 });
    assert.equal(passResult.budget.exceeded, false);

    const failResult = audit({ project: root, includeGlobal: false, budget: 10 });
    assert.equal(failResult.budget.exceeded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('topSkills calculates and sorts metadata tokens correctly', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-top-'));
  try {
    skill(join(root, '.commandcode/skills/small'), 'small', 'short');
    skill(join(root, '.commandcode/skills/large'), 'large', 'a'.repeat(400));
    const result = audit({ project: root, includeGlobal: false });
    assert.ok(result.cmd.topSkills.length >= 2);
    assert.equal(result.cmd.topSkills[0].name, 'large');
    assert.ok(result.cmd.topSkills[0].tokens > result.cmd.topSkills[1].tokens);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix flag renames mismatched directory and cleans broken symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-fix-'));
  try {
    skill(join(root, '.commandcode/skills/wrong-name'), 'correct-name', 'a skill with mismatched directory');
    symlinkSync(join(root, 'non-existent'), join(root, '.commandcode/skills/dangling'));

    const before = audit({ project: root, includeGlobal: false });
    assert.equal(before.invalid.length, 1);
    assert.equal(before.broken.length, 1);

    const after = audit({ project: root, includeGlobal: false, fix: true });
    assert.equal(after.fixes.length, 2);
    assert.equal(after.invalid.length, 0);
    assert.equal(after.broken.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findMissingReferences flags missing links and scripts while ignoring codeblocks and external links', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-ref-'));
  try {
    const skillDir = join(root, 'my-skill');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    writeFileSync(join(skillDir, 'scripts/existing.sh'), '#!/bin/sh\n');

    const markdown = [
      '# My Skill',
      '',
      'See [docs](https://example.com) or [jump](#heading).',
      'Valid link: [existing](scripts/existing.sh)',
      'Missing link: [missing doc](./references/guide.md)',
      'Valid script: `scripts/existing.sh`',
      'Missing script: `scripts/missing.py`',
      '',
      '```markdown',
      'Example inside fenced code block should be ignored:',
      '[fake](references/ignored.md)',
      '`scripts/fake.sh`',
      '```',
      '',
      'Placeholder: `scripts/<id>.sh` or `path/to/script.py`',
    ].join('\n');

    const missing = findMissingReferences(markdown, skillDir);
    assert.equal(missing.length, 2);
    const refs = missing.map((m) => m.ref);
    assert.ok(refs.includes('./references/guide.md'));
    assert.ok(refs.includes('scripts/missing.py'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit detects missing companion assets and reports them', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-audit-missing-'));
  try {
    const dir = join(root, '.commandcode/skills/broken-ref');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: broken-ref\ndescription: has broken ref\n---\n\nRun `scripts/missing.sh` to setup.',
    );

    const result = audit({ project: root, includeGlobal: false });
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].name, 'broken-ref');
    assert.equal(result.missing[0].ref, 'scripts/missing.sh');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('payload tokens calculation and --by payload sorting work properly', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-payload-'));
  try {
    // Skill A: heavy metadata (300 chars), light payload (350 chars total)
    const dirA = join(root, '.commandcode/skills/heavy-meta');
    mkdirSync(dirA, { recursive: true });
    writeFileSync(
      join(dirA, 'SKILL.md'),
      `---\nname: heavy-meta\ndescription: ${'m'.repeat(300)}\n---\n\nShort.`,
    );

    // Skill B: light metadata (20 chars), heavy payload (2000 chars total)
    const dirB = join(root, '.commandcode/skills/heavy-payload');
    mkdirSync(dirB, { recursive: true });
    writeFileSync(
      join(dirB, 'SKILL.md'),
      `---\nname: heavy-payload\ndescription: short desc\n---\n\n${'p'.repeat(2000)}`,
    );

    const result = audit({ project: root, includeGlobal: false });
    assert.ok(result.cmd.payloadTokens > result.cmd.tokens);

    // By catalog (default): heavy-meta should be first
    const catalogSorted = [...result.cmd.topSkills].sort((a, b) => b.tokens - a.tokens);
    assert.equal(catalogSorted[0].name, 'heavy-meta');

    // By payload: heavy-payload should be first
    const payloadSorted = [...result.cmd.topSkills].sort((a, b) => b.payloadTokens - a.payloadTokens);
    assert.equal(payloadSorted[0].name, 'heavy-payload');
    assert.ok(payloadSorted[0].payloadTokens > 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

