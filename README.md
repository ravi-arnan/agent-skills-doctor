# agent-skills-doctor

Zero-dependency health check, linter, and token auditor for AI coding agent skills.

Works across **Claude Code**, **Command Code**, **OpenCode**, **Cursor**, **Windsurf**, **Cline**, **Antigravity**, **Codex**, and 8 other agent harnesses.

```bash
npx agent-skills-doctor
```

---

## Why this exists

Modern AI agent harnesses discover and load skills dynamically from user and project directories. As developers accumulate skills from various kits, several silent problems emerge:

1. **Silent Drops**: If a skill's frontmatter `name` does not match its folder name, or if the name violates agent naming constraints, harnesses silently skip it without warning. You assume the agent has the skill, but it does not.
2. **Context Window Bloat**: Every skill catalog entry injected into your agent's system prompt costs tokens on every single turn.
3. **Skill Drift**: Multiple tools often keep separate copies of the same skill. Edits made in one folder leave other agent environments running stale or conflicting versions.
4. **Dangling Symlinks**: Deleted or moved skill sources leave broken links that can cause runtime exceptions.

`agent-skills-doctor` performs a fast, read-only audit across all agent directories on your machine, reporting these silent failures and calculating the exact token footprint of your loaded skills catalog.

---

## Quickstart

Run directly without installing:

```bash
npx agent-skills-doctor
```

Or install globally:

```bash
npm install -g agent-skills-doctor
skills-doctor
```

---

## What it checks

- **Invalid Skills**: Flags skills skipped by harnesses due to invalid frontmatter, mismatched directory names, missing descriptions, or invalid characters.
- **Dangling Symlinks**: Finds symlinks pointing to non-existent targets.
- **Skill Drift**: Detects skills with identical names but different content (SHA-256 hash comparison across agent directories).
- **Shadowed Skills**: Identifies duplicate skills across project and global roots where higher-precedence roots override lower-precedence ones.
- **Token Budget**: Measures the exact metadata token consumption loaded into your agent's context window.

---

## Supported Harnesses

`agent-skills-doctor` automatically discovers skills across 16 agent harnesses:

| Harness | Global Path | Project Path |
|---|---|---|
| **Claude Code** | `~/.claude/skills` | `.claude/skills` |
| **Command Code** | `~/.commandcode/skills` | `.commandcode/skills` |
| **OpenCode** | `~/.config/opencode/skills` | `.config/opencode/skills` |
| **Cursor** | `~/.cursor/skills` | `.cursor/skills` |
| **Windsurf** | `~/.codeium/windsurf/skills` | `.windsurf/skills` |
| **Cline** | `~/.cline/skills` | `.cline/skills` |
| **Antigravity / Gemini CLI** | `~/.gemini/config/skills` | `.gemini/skills` |
| **Codex** | `~/.codex/skills` | `.codex/skills` |
| **GitHub Copilot** | `~/.copilot/skills` | `.github/skills` |
| **Roo Code** | `~/.roo/skills` | `.roo/skills` |
| **Continue** | `~/.continue/skills` | `.continue/skills` |
| **Augment** | `~/.augment/skills` | `.augment/skills` |
| **Kiro** | `~/.kiro/skills` | `.kiro/skills` |
| **Qwen Code** | `~/.qwen/skills` | `.qwen/skills` |
| **Shared Agents** | `~/.agents/skills` | `.agents/skills` |
| **Project Repo** | - | `skills/` |

---

## CLI Options

```text
usage: skills-doctor [--json] [--project <dir>] [--no-global] [--no-project] [--root <dir>]...

Options:
  --json         Print machine-readable JSON output
  --project      Directory to resolve project roots against (default: current working directory)
  --no-global    Skip user-level global roots
  --no-project   Skip project-level roots
  --root <dir>   Add an extra custom root directory to scan (repeatable)
  -h, --help     Show this help message
```

### Exit Codes
- `0`: Clean tree, no problems found.
- `1`: Problems detected (invalid skills, broken symlinks, or content drift).
- `2`: Usage or configuration error.

---

## CI / Pre-commit Integration

Add `agent-skills-doctor` to your CI pipeline or pre-commit hooks to ensure skills repository hygiene:

```yaml
# .github/workflows/skills-lint.yml
name: Lint Skills
on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx agent-skills-doctor --no-global
```

---

## Design Principles

- **Zero Dependencies**: Built entirely with Node.js standard library (`node:fs`, `node:crypto`, `node:path`).
- **Strictly Read-Only**: Never alters, writes, or deletes your files.
- **Fast**: Audits thousands of skills across all directories in under 50 milliseconds.

---

## License

[MIT](LICENSE) © 2026 Ravi Arnan
