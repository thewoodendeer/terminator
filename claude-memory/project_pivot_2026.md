---
name: Terminator pivot — YouTube sample chopper / pad sampler (PROTOTYPE BUILT)
description: Chopper feature is built and shipping inside the existing Electron app as of 2026-04-25 (commits 64eb304 + fd7ef5b). LOOPER ↔ CHOPPER mode tabs at the top; CHOPPER is the default. Loop-sampler workflow still works behind the LOOPER tab but is legacy.
type: project
originSessionId: 02cecf55-e2a1-4018-94ce-f52e6c865791
---
Status as of 2026-04-25: chopper prototype is built end-to-end and committed. App.tsx now renders a top-level mode toggle; CHOPPER is the default mode.

**What's built (in repo, see `CLAUDE_MEMORY.md` "Chopper Mode — current build" section for full architecture):**
- Playlist selector (4 JSONs at repo-root `/data/`), GET SAMPLE button (random pick), custom URL input
- yt-dlp shell-out from main process via `src/main/youtubeDownloader.ts` — uses `-f bestaudio` so no ffmpeg dep; renderer's `decodeAudioData` handles m4a/opus natively
- `src/renderer/chopper/ChopperEngine.ts` — own AudioContext, master FX (Filter → EQ3 → parallel-mix Compressor → Delay → Reverb → masterGain → masterLimiter), 16 pads, voices, timeline recording, offline-render exports
- 4×4 PadGrid with QWERT keyboard layout (1234 / QWER / ASDF / ZXCV), oneshot/loop per-pad toggle, right-click-to-assign-mode
- WaveformView with chop-region shading, draggable boundaries (8px hit zone), BPM ruler when known
- MasterFXPanel with compressor style presets (off/light/punchy/ny/aggressive) + parallel-mix knob
- Timeline component (ARM/REC/CLEAR), records pad-trigger events and visualizes them at start times
- Export Master + Export Chops to MPC card (or save dialog if no card detected) — both run through master FX in OfflineAudioContext
- Onset-energy + autocorrelation BPM detector (pure-JS, no WASM dep)

**Killavic's machine setup quirks:** `yt-dlp.yt-dlp` installed via WinGet user-scope at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_*\yt-dlp.exe`. The Links/ symlink wasn't created on user-scope install, so the downloader's `findYtDlp()` scans the Packages dir as a fallback. Also has `yt-dlp.FFmpeg` package available though we don't currently invoke it.

**What's NOT yet built that the original spec mentioned:**
- MIDI input (Tone.js was discussed but not wired) — keyboard + mouse only currently
- Phaser, Flanger, Tape master FX — only filter / EQ / comp / delay / reverb landed
- Manual BPM override (auto-detect only)
- Worker-thread BPM detection — currently runs synchronously, may briefly block UI for 5-min+ samples

**How to apply:** When Killavic talks about Terminator: the chopper IS the product now. Propose moves that improve the chopper. Loop-sampler-only pieces (multi-track, bar-accurate retrigger, per-track FX panels) are legacy and shouldn't be extended. Killavic still plans an eventual fork to a fresh React+Vite webapp (separate repo) — the Electron prototype is the validation step.
