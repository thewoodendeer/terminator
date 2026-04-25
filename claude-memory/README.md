# claude-memory/

A versioned mirror of Claude Code's per-project auto-memory entries. The "live" copy lives at `~/.claude/projects/c--Users-ellio-Git-Repos-terminator/memory/` on each machine; this folder is the canonical backup so the memory survives across machines, disk wipes, and fresh clones.

## What lives here

- **`MEMORY.md`** — index file. One line per entry, format: `- [Title](file.md) — short hook`. Loaded into context automatically by Claude Code at session start.
- **`user_*.md`** — facts about Killavic (the user) and his environment.
- **`feedback_*.md`** — calibrated communication / commit / collaboration preferences captured from prior sessions.
- **`project_*.md`** — point-in-time project status notes (e.g. the pivot to chopper mode).
- **`reference_*.md`** — pointers to authoritative sources (e.g. that `CLAUDE_MEMORY.md` is the canonical architecture doc).

## How it stays in sync

These files are **not** auto-synced with `~/.claude/...`. When updating memory:
1. Edit the file under `~/.claude/projects/.../memory/` (the live copy used at runtime).
2. Copy the updated file into `claude-memory/` in this repo.
3. Commit both together.

In practice the two should be byte-identical except for `originSessionId` in the frontmatter (which is set by the runtime).

## Why not `.claude/`

The `.claude/` directory is gitignored because it stores transcript metadata that doesn't belong in version control. `claude-memory/` is a separate, tracked folder dedicated to the long-lived memory entries only.
