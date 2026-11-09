import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { audit, parseFrontmatter, validate } from './cli.mjs';

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
