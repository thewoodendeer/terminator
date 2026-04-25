---
name: TERMINATOR PROJECT
description: Electron-based audio looper/sampler with Web Audio API, React frontend, full effects chain, and MIDI input
type: project
github: https://github.com/thewoodendeer/terminator
originSessionId: a69a1c0d-f8c5-4cd7-ac10-35d7ce6c4179
---
# TERMINATOR PROJECT

Electron + React + Web Audio API audio looper/sampler. Cross-platform; current working checkout is at `c:\Users\ellio\Git Repos\terminator` (Windows).

**GitHub:** https://github.com/thewoodendeer/terminator

**Why:** Personal music production tool — a loop-based sampler with a full per-track FX chain, MIDI chromatic playback, and stem export.

**How to apply:** When the user mentions Terminator, audio engine bugs, effects chain, or looper UI — this is the project.

---

## ⚠️ PIVOT IN PROGRESS (2026-04-25)

The product vision is changing. The loop-sampler architecture below is the **starting point we are prototyping inside**, not the destination.

**New direction:** YouTube sample chopper + MPC-style 4×4 pad sampler. Curated YouTube playlists (`/public/data/*.json`, output of `yt-dlp --dump-json`) → random track pull → BPM detection → waveform display (2-bar grid, 4-bar viewport) → auto/manual chops → assign chops to 4×4 pads (one-shot or loop) → trigger via MIDI / keyboard QWER rows / mouse → triggered hits stack on a timeline → master FX (filter, 3-band EQ, compressor with style-preset dropdown, delay, reverb, phaser, flanger, tape) → export master mix or individual labeled chops.

**Where work happens:** Inside this Electron repo for now. Killavic will fork to a fresh React+Vite webapp once the flow is validated.

**What carries over from the loop sampler:**
- Effect classes (`Filter`, `EQ3`, `Compressor`, `Delay`, `Reverb`, `Phaser` if added) — they already accept `BaseAudioContext` so they work in OfflineAudioContext for export.
- `Track.renderOffline` pattern (chop preview / export rendering)
- `WaveformDisplay` component (with extension for chop markers + drag handles)
- MPC card detection + eject + export to `/Samples/User/TERMINATOR` (use this for chop export too)
- `StemExporter` WAV encoder
- AudioWorklet wiring (the publicDir gotcha and worklet-init pattern)

**What gets transformed or removed:**
- Multi-track loop record/overdub flow → single-source workflow (one YouTube track at a time)
- Per-track FX panel → master FX only
- Bar-accurate retrigger scheduler → not needed; pads are triggered ad-hoc and arranged on a timeline
- TrackStrip → replaced by the pad grid + timeline
- Time-stretch/pitch knobs (per-track) → optional per-pad; stretch already pitch-preserving via soundtouchjs
- MIDI chromatic playback → keep MIDI input, but route to pad triggers (not chromatic per-track)

**Compressor note:** target UX has a single MIX knob plus a dropdown for compressor "style" (light, punchy, NY comp, aggressive). Implementation idea: keep our drive-style `Compressor` and have the dropdown set DRIVE/RATIO/ATTACK/RELEASE/MAKEUP presets; expose only the mix to the user.

**Tech notes for the new pieces (when we build them):**
- YouTube audio in Electron: easiest is `ytdl-core` or shelling to `yt-dlp` from main process, downloading to a temp file, then loading into AudioContext via `decodeAudioData`. Avoids iframe-capture sketchiness; works because Electron has filesystem + child_process.
- BPM detection: Essentia.js (heavy WASM but accurate) or a lighter onset-energy approach. Start simple, upgrade if needed.
- Waveform: keep current `WaveformDisplay` and add a chop-marker overlay; or swap in Peaks.js when going to webapp.
- Pad grid: new component, 4×4 grid; clicking a pad while a chop region is highlighted on the waveform assigns the chop to that pad.

---

## Chopper Mode — current build

The chopper is live alongside the looper. App.tsx renders a top tab bar (`CHOPPER` / `LOOPER`); chopper is the default.

### Architecture

- `src/main/youtubeDownloader.ts` — shells out to `yt-dlp -f bestaudio` and returns the audio file as an `ArrayBuffer` plus title/duration/videoId. **No ffmpeg dependency** (we keep the native m4a/opus stream and let `decodeAudioData` handle it). Looks for yt-dlp in PATH and the WinGet user-scope Links dir.
- `src/main/playlists.ts` — reads `data/playlist*.json` (NDJSON or JSON-array — both work; that's the format yt-dlp's `--dump-json` emits). Each entry is `{id, title, duration?}`.
- `src/main/main.ts` — IPC handlers: `chopper:listPlaylists`, `chopper:downloadYouTube`. The data dir is `<repo>/data` in dev (`__dirname/../../data`) and `process.resourcesPath/data` in a packaged build.
- `src/preload/preload.ts` — exposes `listPlaylists()` and `downloadYouTube(idOrUrl)`.
- `src/renderer/chopper/ChopperEngine.ts` — owns its own `AudioContext`, master FX chain (Filter → EQ3 → parallel-mixed Compressor → Delay → Reverb → masterGain → masterLimiter), 16 pads, chop list, voices, timeline recording. `triggerPad/releasePad` for live performance, `exportMaster/exportChops` for offline render via `OfflineAudioContext` mirroring the live FX chain. Compressor exposes 5 style presets (`off/light/punchy/ny/aggressive`) plus a user-controlled mix (NY = parallel default 50%).
- `src/renderer/chopper/PadGrid.tsx` — 4×4 grid; right-click pad to enter assignment mode (then click a chop region on the waveform to assign); left-click to trigger; small ▶/∞ button to toggle one-shot/loop. Keyboard layout: row 0=`1234`, row 1=`QWER`, row 2=`ASDF`, row 3=`ZXCV`. Window-level keyboard listener that ignores key repeat and skips when typing in inputs.
- `src/renderer/chopper/WaveformView.tsx` — full-track canvas with chop region shading, boundary lines, pad-color number tags, BPM ruler when known. Drag chop boundaries by grabbing within 8px of a vertical line. Click a region to preview the assigned pad (or to assign when a pad is selected).
- `src/renderer/chopper/MasterFXPanel.tsx` — knobs/sliders for Filter (log-mapped wide cutoff slider), EQ low/mid/high, Compressor style + mix, Delay time/feedback/mix, Reverb decay/mix.
- `src/renderer/chopper/Timeline.tsx` — visual stack of recorded triggers; ARM/REC/CLEAR controls. Empty timeline triggers a default fall-back render (pads in order, back-to-back) when exporting master.
- `src/renderer/chopper/bpmDetect.ts` — onset-energy + autocorrelation BPM estimator. ~6 kHz decimation, half-wave-rectified envelope difference, autocorrelate over the 60–200 BPM lag range, pick the strongest peak, snap to 75–160 by halving/doubling. Decent for breakbeats / soul / lofi; not as good as Essentia.js but no WASM dep.

### Chopper UX

- **Get Sample**: select playlist → click → random track pulled, BPM auto-detected, 16 equal-slice chops auto-created, chops auto-assigned to pads 1–16.
- **Custom URL**: Enter a YouTube URL in the toolbar input; same flow as Get Sample but for a specific track.
- **Trigger pads**: keyboard rows or mouse click. Loop pads keep playing until released (mouse-up / key-up); one-shots play to chop end.
- **Re-assign**: right-click a pad → it pulses purple (selected) → click a chop region on the waveform → assignment lands. Press Esc to cancel.
- **Adjust chops**: drag a chop's start or end boundary on the waveform.
- **Export Master**: renders the recorded timeline (or a default fall-back if none) through the master FX chain into a single WAV. Lands on the MPC card in the existing `<card>/<MPC>/Samples/User/TERMINATOR/` if detected, else save dialog.
- **Export Chops**: renders each assigned pad's chop through the same FX chain, named `<title>_<bpm>BPM_padNN`. Same MPC-or-dialog destination.

### Setup gotchas

- **yt-dlp must be installed.** `winget install yt-dlp.yt-dlp` (user-scope is fine) or `choco install yt-dlp`. Restart the dev process after installing so the new PATH is picked up.
- **No ffmpeg required.** We deliberately use `-f bestaudio` (no `--audio-format wav`) so yt-dlp doesn't need ffmpeg. Browser `decodeAudioData` handles m4a/opus/aac natively.
- **Playlist data location:** `data/playlist*.json` at repo root. Files are read by main process via fs (not by Vite as static assets), so they don't need to live under `public/`.

---

## Architecture

- `src/renderer/audio/AudioEngine.ts` — Central engine: manages tracks, BPM, bars, swing, quantize, undo/redo, MIDI routing, master volume/limiter, pre-count logic. Delegates to `LoopRecorder`, `Quantizer`, `StemExporter`
- `src/renderer/audio/Track.ts` — Per-track audio graph: buffer playback, loop sync, pitch/stretch, all effects, MIDI polyphonic note handling, loopGain fade envelope. Exports `DEFAULT_FX_ORDER` and the `EffectKey` union
- `src/renderer/audio/LoopRecorder.ts` — `MediaRecorder`-based loop capture (webm/opus); returns decoded `AudioBuffer` on stop
- `src/renderer/audio/TimeStretcher.ts` — `stretchBuffer(ctx, buf, tempo, pitchSemitones)`: offline pitch-preserving time-stretch + time-preserving pitch-shift via soundtouchjs (SoundTouch + SimpleFilter + WebAudioBufferSource). Returns a new AudioBuffer; no-op if tempo≈1 && pitch≈0. Yields to event loop every 8 chunks so long samples don't block UI.
- `src/renderer/audio/Quantizer.ts` — `GridDiv` type (straight + triplet divisions) and BPM/swing-aware grid-snap helper
- `src/renderer/audio/StemExporter.ts` — WAV encoder (8/16/24/32-bit) + `exportStem` / `exportMaster`. Wet export delegates to `Track.renderOffline(loopDuration, bpm)` which builds a fresh effects chain in an `OfflineAudioContext`, mirrors all knobs from live state, and renders. Dry export = raw buffer. Master export renders each non-muted/soloed track and sums the resulting buffers.
- `src/main/mpcDetector.ts` — Cross-platform removable-drive enumeration (Windows: `Get-Volume`; macOS: `/Volumes`; Linux: `lsblk`). Recognizes Akai MPC cards by folder name (`/^MPC[-_ ]?/i`) or signature dirs (`Expansions`, `Projects`, `Samples`). Resolves preferred export dir to `<card>/<MPC folder>/Samples/User/TERMINATOR` (so exports show up in the MPC's user-samples browser). Also exports `ejectDriveForExportDir`: pre-closes Explorer windows pointed at the drive, runs Shell.Application Eject, falls back to `mountvol /D`, verifies via `fs.access` polling.
- `scripts/run-electron.js` — Tiny Node wrapper for `start`/`dev`. `delete process.env.ELECTRON_RUN_AS_NODE` before spawning Electron, otherwise that env var (commonly set in dev shells) makes `require('electron')` return the binary path string instead of the API and crashes any real Electron app.
- `src/renderer/audio/MidiInput.ts` — Web MIDI API wrapper, hotplug via `onstatechange`, note-on/off routing
- `src/renderer/audio/Metronome.ts` — BPM-accurate click scheduler; has `countIn(bpm, beats)` for pre-count
- `src/renderer/audio/effects/` — Individual effect modules (see list below)
- `src/renderer/components/TrackStrip.tsx` — Per-track UI strip with all controls
- `src/renderer/components/EffectsPanel.tsx` — Collapsible FX panel per track, drag-to-reorder; click "FX CHAIN ▲" to collapse
- `src/renderer/components/Transport.tsx` — Play/stop/record, BPM, bars, swing, quantize, undo/redo; shows "◎ COUNT" during pre-count
- `src/renderer/components/MasterSection.tsx` — Master volume, limiter, stem export
- `src/renderer/components/WaveformDisplay.tsx` — Waveform / spectrum analyzer
- `src/renderer/styles/terminator.css` — All styles, CRT scanline aesthetic, neon color palette
- `public/worklets/` — AudioWorklet processors: `ms-eq-worklet.js`, `bit-crusher-worklet.js`, `stereo-widener-worklet.js`, `trance-gate-worklet.js`

---

## Effects Chain (per track, reorderable)

Default order (`DEFAULT_FX_ORDER` in `Track.ts`):
`filter` → `eq` → `clipper` → `waveshaper` → `saturator` → `compressor` → `widener` → `mseq` → `chorus` → `delay` → `reverb` → `bitcrusher` → `autopan` → `trancegate`

All effects start **bypassed**. Each uses external `dryGain`/`wetGain` GainNodes for bypass/mix — NOT in-worklet mix params (those fail silently when worklet is null).

### Effect details
- **Filter** — native BiquadFilterNode; LP/HP/BP type buttons; Q buttons 6/12/18; FreqKnob + Mix
- **EQ3** — 3-band shelving (low 60Hz, mid 2kHz, high 12kHz)
- **Clipper** — soft/hard clip with drive
- **Waveshaper** — tanh waveshaping
- **MB Saturator** — multiband saturation with low/high freq crossover
- **Compressor** — drive-style single-band compressor. Fixed internal threshold (−18 dB) and knee (6 dB); user controls via DRIVE (input gain 0–24 dB pushing into the compressor), RATIO (1:1–20:1), ATTACK (1–300 ms), RELEASE (10 ms–1 s), MAKEUP (−24..+24 dB). Bypass collapses to unity by zeroing drive/makeup gain and setting ratio to 1. Replaced the earlier 3-band OTT (which used band-split DynamicsCompressors with a depth knob controlling ratio/threshold).
- **Stereo Widener** — AudioWorklet mid/side width
- **M/S EQ** — AudioWorklet; external dry/wet; freq+gain per mid and side band
- **BitCrusher** — AudioWorklet (bit-crusher-worklet.js); external dry/wet; worklet outputs 100% crushed (no mix param); default 8-bit/mix=1
- **AutoPan** — OscillatorNode LFO → StereoPannerNode
- **TranceGate** — AudioWorklet (`trance-gate-worklet.js`); sample-accurate square LFO with independent asymmetric attack/release one-pole envelope; external dry/wet; BPM sync supported (host computes effective Hz from BPM × syncDiv before setting `rate` param)
- **Chorus** — OscillatorNode LFO → DelayNode
- **Delay** — stereo delay with ping-pong
- **Reverb** — ConvolverNode with pre-HPF

---

## Key Technical Decisions

- **Lookahead bar scheduler**: `AudioEngine.startClock()` uses 100ms lookahead; calls `t.scheduleRetrigger(nextBarTime)` on all tracks before each bar boundary. Guarantees sample-accurate loop sync regardless of buffer length or setTimeout jitter.
- **Loop source lifecycle**: sources use `src.loop = false`; scheduler stops old source at bar boundary and starts new one. `pendingStops: Set<AudioBufferSourceNode>` tracks scheduled-stop sources for immediate cleanup on `stop()`.
- **loopGain fade envelope**: `Track.loopGain` GainNode sits between all loop sources and `gainNode`. Every play/retrigger does 4ms linear fade-in (0→1); retrigger also does 4ms fade-out before stop. MIDI notes connect directly to `gainNode`, bypassing loopGain.
- **TranceGate worklet**: Sample-accurate phase counter + asymmetric one-pole envelope (separate `attackCoeff`/`releaseCoeff`). Replaced the earlier native square-LFO + lowpass-smoother version, which couldn't provide asymmetric attack/release (single lowpass = symmetric rise/fall) and whose release knob was non-functional. Worklet outputs 100% wet; host controls mix via external dry/wet GainNodes.
- **BitCrusher fix**: Was broken because internal worklet `mix` param made effect invisible. Rewritten with external dry/wet. Worklet now outputs 100% crushed signal only.
- **MSEQ**: AudioWorklet with external dry/wet bypass. Worklet outputs processed signal only; host controls mix via GainNodes.
- **MIDI chromatic**: `detune = (midiNote − rootNote) × 100` (+ `pitch × 100` only when falling back to the raw buffer; otherwise pitch is baked into the processed buffer). Polyphonic via `Map<number, {src, vel}>`. Note-off: 15ms fade → stop at +80ms.
- **Pitch-preserved time-stretch**: `timeStretch` and `pitch` are now **independent**. `Track` keeps a `processedBuffer` (+ `processedReversedBuffer`) generated asynchronously via `stretchBuffer`. Playback uses the processed buffer at `playbackRate=1`/`detune=0` so stretch/pitch are baked in. On change to buffer/stretch/pitch/reverse: processed buffers are invalidated and regeneration is debounced 150ms; a version counter discards superseded results. While regeneration is pending, playback falls back to the raw buffer with the original varispeed path so audio never drops. `loopStartOffset` is stored in raw-buffer seconds and scaled by `1/timeStretch` when addressing the processed buffer.
- **Double-click reset**: All knobs/faders/inputs have `onDoubleClick` returning to default value.
- **4-click pre-count**: `startRecording()` when stopped: plays 4 BPM-synced clicks via `metronome.countIn()`, awaits `4 * beatDuration * 1000 + 50` ms, checks `countInAborted` flag (set by `stop()`), then starts recording. Transport shows "◎ COUNT" and disables REC button during count-in.
- **Effects accept `BaseAudioContext`, not `AudioContext`**: All effect classes' constructors take `BaseAudioContext` so they can be reconstructed inside an `OfflineAudioContext` for wet stem rendering. Audio-node factories and `audioWorklet` are on `BaseAudioContext`, so this works for both real-time and offline.
- **Vite `publicDir` gotcha**: `vite.config.ts` sets `root: 'src/renderer'`, so Vite's default `publicDir` would resolve to `src/renderer/public/` — but our worklets live at the repo-root `public/`. Without an explicit `publicDir: path.resolve(__dirname, 'public')` setting, every `audioWorklet.addModule('./worklets/...')` 404s and the effect silently falls back to passthrough. Don't move the worklets without updating this.
- **MPC detection runs in main process**: 2-second poll via `findMpcExportDir`. Status broadcast over IPC `mpc:status` (full export-dir path, or null). Renderer subscribes via preload's `onMpcStatus`. Polling pauses while an eject is in flight (`ejectInProgress` flag) so our own `fs.readdir`/`fs.stat` doesn't keep a handle on the drive root and prevent dismount.
- **Eject pre-close step**: Before dismount, we enumerate `Shell.Application.Windows()` and `.Quit()` any whose `LocationURL` starts with `file:///<letter>:`. That clears the most common reason eject fails on Windows (Explorer holding the drive). Other apps with file handles are still on the user; we surface the OS error.

---

## EngineState Fields

`isPlaying, isRecording, isCountingIn, recordingTrackId, bpm, bars, swing, quantizeGrid, loopProgress, currentBeat, masterVolume, tracks, metronomeOn, limiterEnabled, canUndo, canRedo, midiConnected, midiInputCount`

## TrackState Fields

`id, name, volume, pan, muted, soloed, armed, midiArmed, rootNote, reversed, timeStretch, pitch, loopStartOffset, quantizeEnabled, quantizeGrid, swingAmount, effects: { filter, eq, clipper, waveshaper, saturator, compressor, widener, mseq, bitcrusher, autopan, trancegate, chorus, delay, reverb, masterBypass, effectsOrder }, hasAudio, bufferDuration, waveformPeaks, color`

---

## UI Conventions

- CRT scanline aesthetic, neon green (`#00ff88`) primary, purple (`#cc00ff`) for MIDI, orange (`#ff6600`) for reverse
- `useDraggableNumber` hook for knob/fader drag interaction
- Knob labels double-click to reset to default
- `ctrl-input` class for text inputs used as drag targets
- FX Chain header "FX CHAIN ▲" is clickable to collapse the panel

---

## Completed Features

- Multi-track loop sampler with record/overdub
- Bar-accurate loop retrigger with lookahead scheduler (all samples lock to bar boundary)
- 4ms sample start/end fade envelope on every loop boundary (no clicks)
- 4-click BPM-synced pre-count before recording when stopped
- Per-track: volume, pan, mute, solo, arm, stretch, pitch, loop start, reverse
- Full FX chain (14 effects) with bypass, master bypass, drag-to-reorder; click FX CHAIN to collapse
- Filter effect: LP/HP/BP, Q=6/12/18, frequency knob
- BPM sync (trance gate), swing, quantize grid
- MIDI chromatic playback (note-on/off, polyphonic, hotplug)
- Undo/redo
- Stem export (WAV, 16/24/32-bit, dry or wet — wet renders through full FX chain offline)
- Master limiter
- Waveform + spectrum analyzer display
- Metronome
- Keyboard shortcuts (Space = play/stop, Cmd+Z/Shift+Z = undo/redo)
- Pitch-preserved time stretch (independent stretch + pitch knobs, soundtouchjs-backed)
- Auto-detect Akai MPC SD cards in card-access mode → one-click export to `<card>/<MPC folder>/Samples/User/TERMINATOR/`, plus safe-eject button (auto-closes Explorer windows on the card before dismount)
