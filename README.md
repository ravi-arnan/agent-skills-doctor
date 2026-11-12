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
- **Missing Assets & Scripts**: Detects referenced companion scripts (e.g. `scripts/run.sh`) or relative markdown links pointing to files missing on disk.
- **Dangling Symlinks**: Finds symlinks pointing to non-existent targets.
- **Skill Drift**: Detects skills with identical names but different content (SHA-256 hash comparison across agent directories).
- **Shadowed Skills**: Identifies duplicate skills across project and global roots where higher-precedence roots override lower-precedence ones.
- **Token Footprint & Payload**: Measures both the catalog metadata token cost (injected every turn) and the full activation payload cost when skills are invoked.

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
usage: skills-doctor [options]

Health check, linter, and token auditor for agent skills across every harness root.

Options:
  --fix          automatically repair safe issues (rename mismatched folders, remove broken links)
  --budget <n>   fail with exit code 1 if metadata exceeds token limit
  --top <n>      display top N skills by token cost
  --by <metric>  metric to sort top skills by: catalog (default) or payload
  --json         machine-readable output
  --project <dir> directory to resolve project roots against (default: cwd)
  --no-global    skip user-level global roots
  --no-project   skip project-level roots
  --root <dir>   extra root to scan (repeatable)
  -h, --help     show this help text
```

### Exit Codes
- `0`: Clean tree, no problems found.
- `1`: Problems detected (invalid skills, broken symlinks, content drift, or exceeded token budget).
- `2`: Usage or configuration error.

---

## CI / GitHub Action Integration

You can use `agent-skills-doctor` directly as a GitHub Action in your workflows:

```yaml
# .github/workflows/skills-doctor.yml
name: Lint Skills
on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ravi-arnan/agent-skills-doctor@main
        with:
          budget: 4000
          no-global: 'true'
```

Or run via `npx`:

```bash
npx agent-skills-doctor --no-global --budget 4000
```


---

## Design Principles

- **Zero Dependencies**: Built entirely with Node.js standard library (`node:fs`, `node:crypto`, `node:path`).
- **Strictly Read-Only**: Never alters, writes, or deletes your files.
- **Fast**: Audits thousands of skills across all directories in under 50 milliseconds.

---

## License

[MIT](LICENSE) © 2026 Ravi Arnan
