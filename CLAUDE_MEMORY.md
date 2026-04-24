---
name: TERMINATOR PROJECT
description: Electron-based audio looper/sampler with Web Audio API, React frontend, full effects chain, and MIDI input
type: project
originSessionId: a69a1c0d-f8c5-4cd7-ac10-35d7ce6c4179
---
# TERMINATOR PROJECT

Electron + React + Web Audio API audio looper/sampler at `/Users/victorborges/terminator`.

**Why:** Personal music production tool — a loop-based sampler with a full per-track FX chain, MIDI chromatic playback, and stem export.

**How to apply:** When the user mentions Terminator, audio engine bugs, effects chain, or looper UI — this is the project.

---

## Architecture

- `src/renderer/audio/AudioEngine.ts` — Central engine: manages tracks, BPM, bars, swing, quantize, undo/redo, MIDI routing, master volume/limiter, stem export, pre-count logic
- `src/renderer/audio/Track.ts` — Per-track audio graph: buffer playback, loop sync, pitch/stretch, all effects, MIDI polyphonic note handling, loopGain fade envelope
- `src/renderer/audio/MidiInput.ts` — Web MIDI API wrapper, hotplug via `onstatechange`, note-on/off routing
- `src/renderer/audio/Metronome.ts` — BPM-accurate click scheduler; has `countIn(bpm, beats)` for pre-count
- `src/renderer/audio/effects/` — Individual effect modules (see list below)
- `src/renderer/components/TrackStrip.tsx` — Per-track UI strip with all controls
- `src/renderer/components/EffectsPanel.tsx` — Collapsible FX panel per track, drag-to-reorder; click "FX CHAIN ▲" to collapse
- `src/renderer/components/Transport.tsx` — Play/stop/record, BPM, bars, swing, quantize, undo/redo; shows "◎ COUNT" during pre-count
- `src/renderer/components/MasterSection.tsx` — Master volume, limiter, stem export
- `src/renderer/components/WaveformDisplay.tsx` — Waveform / spectrum analyzer
- `src/renderer/styles/terminator.css` — All styles, CRT scanline aesthetic, neon color palette
- `public/worklets/` — AudioWorklet processors: `ms-eq-worklet.js`, `bit-crusher-worklet.js`, `stereo-widener-worklet.js`

---

## Effects Chain (per track, reorderable)

`filter` → `eq` → `clipper` → `waveshaper` → `saturator` → `ott` → `widener` → `mseq` → `bitcrusher` → `autopan` → `trancegate` → `chorus` → `delay` → `reverb`

All effects start **bypassed**. Each uses external `dryGain`/`wetGain` GainNodes for bypass/mix — NOT in-worklet mix params (those fail silently when worklet is null).

### Effect details
- **Filter** — native BiquadFilterNode; LP/HP/BP type buttons; Q buttons 6/12/18; FreqKnob + Mix
- **EQ3** — 3-band shelving (low 60Hz, mid 2kHz, high 12kHz)
- **Clipper** — soft/hard clip with drive
- **Waveshaper** — tanh waveshaping
- **MB Saturator** — multiband saturation with low/high freq crossover
- **OTT** — 3-band upward/downward compressor; depth drives ratio (2→20) and threshold (−10→−40 dB) on stored compressor refs
- **Stereo Widener** — AudioWorklet mid/side width
- **M/S EQ** — AudioWorklet; external dry/wet; freq+gain per mid and side band
- **BitCrusher** — AudioWorklet (bit-crusher-worklet.js); external dry/wet; worklet outputs 100% crushed (no mix param); default 8-bit/mix=1
- **AutoPan** — OscillatorNode LFO → StereoPannerNode
- **TranceGate** — native square LFO → WaveShaperNode (0/1 remap) → **smoother BiquadFilter (lowpass, cutoff=0.35/attack)** → lfoDepth → gateGain; BPM sync supported; smoother kills clicks
- **Chorus** — OscillatorNode LFO → DelayNode
- **Delay** — stereo delay with ping-pong
- **Reverb** — ConvolverNode with pre-HPF

---

## Key Technical Decisions

- **Lookahead bar scheduler**: `AudioEngine.startClock()` uses 100ms lookahead; calls `t.scheduleRetrigger(nextBarTime)` on all tracks before each bar boundary. Guarantees sample-accurate loop sync regardless of buffer length or setTimeout jitter.
- **Loop source lifecycle**: sources use `src.loop = false`; scheduler stops old source at bar boundary and starts new one. `pendingStops: Set<AudioBufferSourceNode>` tracks scheduled-stop sources for immediate cleanup on `stop()`.
- **loopGain fade envelope**: `Track.loopGain` GainNode sits between all loop sources and `gainNode`. Every play/retrigger does 4ms linear fade-in (0→1); retrigger also does 4ms fade-out before stop. MIDI notes connect directly to `gainNode`, bypassing loopGain.
- **TranceGate smoother**: BiquadFilterNode (lowpass) after WaveShaperNode; cutoff = min(0.35/attack, 500) Hz. Rounds square-wave edges to kill gating clicks.
- **BitCrusher fix**: Was broken because internal worklet `mix` param made effect invisible. Rewritten with external dry/wet. Worklet now outputs 100% crushed signal only.
- **MSEQ**: AudioWorklet with external dry/wet bypass. Worklet outputs processed signal only; host controls mix via GainNodes.
- **MIDI chromatic**: `detune = (midiNote − rootNote) × 100 + pitch × 100`. Polyphonic via `Map<number, {src, vel}>`. Note-off: 15ms fade → stop at +80ms.
- **Double-click reset**: All knobs/faders/inputs have `onDoubleClick` returning to default value.
- **4-click pre-count**: `startRecording()` when stopped: plays 4 BPM-synced clicks via `metronome.countIn()`, awaits `4 * beatDuration * 1000 + 50` ms, checks `countInAborted` flag (set by `stop()`), then starts recording. Transport shows "◎ COUNT" and disables REC button during count-in.

---

## EngineState Fields

`isPlaying, isRecording, isCountingIn, recordingTrackId, bpm, bars, swing, quantizeGrid, loopProgress, currentBeat, masterVolume, tracks, metronomeOn, limiterEnabled, canUndo, canRedo, midiConnected, midiInputCount`

## TrackState Fields

`id, name, volume, pan, muted, soloed, armed, midiArmed, rootNote, reversed, timeStretch, pitch, loopStartOffset, quantizeEnabled, quantizeGrid, swingAmount, effects: { filter, eq, clipper, waveshaper, saturator, ott, widener, mseq, bitcrusher, autopan, trancegate, chorus, delay, reverb, masterBypass, effectsOrder }, hasAudio, bufferDuration, waveformPeaks, color`

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
- Stem export (WAV, 16/24/32-bit, dry or wet)
- Master limiter
- Waveform + spectrum analyzer display
- Metronome
- Keyboard shortcuts (Space = play/stop, Cmd+Z/Shift+Z = undo/redo)
