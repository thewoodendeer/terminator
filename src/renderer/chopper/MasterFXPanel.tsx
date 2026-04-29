import { ChopperState, CompressorStyle } from './ChopperEngine';

interface Props {
  state: ChopperState;
  onMasterVolume: (v: number) => void;
  onMasterPitch: (semitones: number) => void;
  onFilterFreq: (hz: number) => void;
  onFilterEnabled: (b: boolean) => void;
  onEQ: (band: 'low' | 'mid' | 'high', gainDB: number) => void;
  onCompStyle: (style: CompressorStyle) => void;
  onCompMix: (mix: number) => void;
  onDelayMix: (v: number) => void;
  onDelayTime: (s: number) => void;
  onDelayFeedback: (v: number) => void;
  onReverbMix: (v: number) => void;
  onReverbDecay: (s: number) => void;
}

const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const FREQ_STEPS = 1000;
const freqToFader = (hz: number) => Math.round(Math.log(Math.max(FREQ_MIN, hz) / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN) * FREQ_STEPS);
const faderToFreq = (t: number) => FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t / FREQ_STEPS);

export function MasterFXPanel(props: Props) {
  const m = props.state.master;

  return (
    <div className="master-fx">
      <div className="master-fx-title">MASTER FX</div>

      <div className="fx-row">
        <FXKnob label="VOLUME" value={Math.round(m.volume * 100)} unit="%"
          min={0} max={100} step={1}
          onChange={v => props.onMasterVolume(v / 100)}
          onReset={() => props.onMasterVolume(0.85)} />
        <FXKnob label="PITCH/TEMPO" value={m.pitch} unit=" st"
          min={-24} max={24} step={0.5}
          onChange={v => props.onMasterPitch(v)}
          onReset={() => props.onMasterPitch(0)} />
      </div>

      <div className="fx-section">
        <div className="fx-section-title">
          <button
            className={`fx-toggle ${m.filterEnabled ? 'on' : ''}`}
            onClick={() => props.onFilterEnabled(!m.filterEnabled)}
          >●</button>
          FILTER
        </div>
        <FXSlider label="CUTOFF" value={freqToFader(m.filterFreq)}
          display={m.filterFreq >= 1000 ? `${(m.filterFreq / 1000).toFixed(1)}k Hz` : `${Math.round(m.filterFreq)} Hz`}
          min={0} max={FREQ_STEPS} step={1}
          onChange={v => props.onFilterFreq(Math.round(faderToFreq(v)))}
          onReset={() => props.onFilterFreq(20000)}
          wide />
      </div>

      <div className="fx-section">
        <div className="fx-section-title">EQ</div>
        <div className="fx-row">
          <FXKnob label="LOW"  value={m.eqLow}  unit=" dB" min={-24} max={24} step={0.5}
            onChange={v => props.onEQ('low', v)} onReset={() => props.onEQ('low', 0)} />
          <FXKnob label="MID"  value={m.eqMid}  unit=" dB" min={-24} max={24} step={0.5}
            onChange={v => props.onEQ('mid', v)} onReset={() => props.onEQ('mid', 0)} />
          <FXKnob label="HIGH" value={m.eqHigh} unit=" dB" min={-24} max={24} step={0.5}
            onChange={v => props.onEQ('high', v)} onReset={() => props.onEQ('high', 0)} />
        </div>
      </div>

      <div className="fx-section">
        <div className="fx-section-title">COMPRESSOR</div>
        <div className="fx-row">
          <label className="fx-select-group">
            <span className="fx-label">STYLE</span>
            <select className="fx-select" value={m.compStyle} onChange={e => props.onCompStyle(e.target.value as CompressorStyle)}>
              <option value="off">OFF</option>
              <option value="light">LIGHT</option>
              <option value="punchy">PUNCHY</option>
              <option value="ny">NY (PARALLEL)</option>
              <option value="aggressive">AGGRESSIVE</option>
            </select>
          </label>
          <FXKnob label="MIX" value={Math.round(m.compMix * 100)} unit="%"
            min={0} max={100} step={1}
            onChange={v => props.onCompMix(v / 100)}
            onReset={() => props.onCompMix(m.compStyle === 'ny' ? 0.5 : 1)} />
        </div>
      </div>

      <div className="fx-section">
        <div className="fx-section-title">DELAY</div>
        <div className="fx-row">
          <FXKnob label="TIME" value={Number(m.delayTime.toFixed(3))} unit="s" min={0.01} max={2} step={0.01}
            onChange={v => props.onDelayTime(v)} onReset={() => props.onDelayTime(0.25)} />
          <FXKnob label="FBK" value={Math.round(m.delayFeedback * 100)} unit="%"
            min={0} max={95} step={1}
            onChange={v => props.onDelayFeedback(v / 100)}
            onReset={() => props.onDelayFeedback(0.3)} />
          <FXKnob label="MIX" value={Math.round(m.delayMix * 100)} unit="%"
            min={0} max={100} step={1}
            onChange={v => props.onDelayMix(v / 100)}
            onReset={() => props.onDelayMix(0)} />
        </div>
      </div>

      <div className="fx-section">
        <div className="fx-section-title">REVERB</div>
        <div className="fx-row">
          <FXKnob label="DECAY" value={Number(m.reverbDecay.toFixed(2))} unit="s" min={0.1} max={6} step={0.1}
            onChange={v => props.onReverbDecay(v)} onReset={() => props.onReverbDecay(2)} />
          <FXKnob label="MIX" value={Math.round(m.reverbMix * 100)} unit="%"
            min={0} max={100} step={1}
            onChange={v => props.onReverbMix(v / 100)}
            onReset={() => props.onReverbMix(0)} />
        </div>
      </div>
    </div>
  );
}

function FXKnob({ label, value, unit = '', min, max, step, onChange, onReset }: {
  label: string; value: number; unit?: string; min: number; max: number; step: number;
  onChange: (v: number) => void; onReset: () => void;
}) {
  return (
    <label className="fx-knob" onDoubleClick={onReset} title="Double-click to reset">
      <span className="fx-label">{label}</span>
      <input type="range" className="fx-slider" min={min} max={max} step={step}
        value={value} onChange={e => onChange(Number(e.target.value))} />
      <span className="fx-value">
        {Number.isInteger(value) ? value : value.toFixed(2)}{unit}
      </span>
    </label>
  );
}

function FXSlider({ label, value, display, min, max, step, onChange, onReset, wide }: {
  label: string; value: number; display: string; min: number; max: number; step: number;
  onChange: (v: number) => void; onReset: () => void; wide?: boolean;
}) {
  return (
    <label className={`fx-knob ${wide ? 'fx-knob-wide' : ''}`} onDoubleClick={onReset} title="Double-click to reset">
      <span className="fx-label">{label}</span>
      <input type="range" className={`fx-slider ${wide ? 'fx-slider-wide' : ''}`}
        min={min} max={max} step={step}
        value={value} onChange={e => onChange(Number(e.target.value))} />
      <span className="fx-value">{display}</span>
    </label>
  );
}
