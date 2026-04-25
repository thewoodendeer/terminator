---
name: Commit message style for Terminator
description: Lowercase, no conventional-commits prefixes, short subject + bullet body. Match `git log` not external conventions.
type: feedback
originSessionId: 02cecf55-e2a1-4018-94ce-f52e6c865791
---
Commits in this repo follow a simple lowercase style: concise subject (no `feat:` / `fix:` prefixes), optional bullet body for multi-change commits. Match the existing log (`git log --oneline`) — initial commit was `add claude memory`, not `chore: add claude memory`.

**Why:** This is a personal project, not a team codebase with a release-notes bot. Conventional-commits formatting adds noise without payoff for the audience (one developer reading their own log).

**How to apply:** Use lowercase imperative subjects. Multi-line bodies are fine when changes span multiple concerns — bullet them. Always include the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
