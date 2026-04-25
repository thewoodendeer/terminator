---
name: In-repo architecture doc — CLAUDE_MEMORY.md
description: The repo's CLAUDE_MEMORY.md is the canonical Terminator architecture doc. Read it first for any non-trivial work, and update it when the architecture changes.
type: reference
originSessionId: 02cecf55-e2a1-4018-94ce-f52e6c865791
---
Terminator keeps its architecture doc in-tree at `CLAUDE_MEMORY.md` (root of the repo). It covers: file layout, FX chain order + per-effect notes, key technical decisions (lookahead scheduler, loopGain fades, pitch-preserved stretch, MPC export, Vite publicDir gotcha, etc.), engine/track state shapes, and completed features.

**How to use it:**
- Before proposing structural changes, read it — most "why is this like this" questions are answered there.
- After making structural changes (new module, renamed effect, changed default FX order, new feature spanning main+renderer+preload), **update it in the same change**. Stale architecture docs are worse than none.
- It's checked into git, so future Claude sessions on a fresh clone get it automatically. The auto-memory here in `~/.claude/...` is for things that *don't* belong in the repo (user profile, communication style, machine quirks).
