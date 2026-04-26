import { useEffect, useRef } from 'react';
import { ChopperState, Pad } from './ChopperEngine';

interface Props {
  state: ChopperState;
  onTrigger: (padIdx: number, velocity?: number) => void;
  onRelease: (padIdx: number) => void;
  onSelect: (padIdx: number) => void;
  onToggleMode: (padIdx: number) => void;
  onClear: (padIdx: number) => void;
  onPitch: (padIdx: number, semitones: number) => void;
}

const KEY_TO_PAD: Record<string, number> = {
  '1': 0, '2': 1, '3': 2, '4': 3,
  'q': 4, 'w': 5, 'e': 6, 'r': 7,
  'a': 8, 's': 9, 'd': 10, 'f': 11,
  'z': 12, 'x': 13, 'c': 14, 'v': 15,
};
const KEY_LABELS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];

export function PadGrid({ state, onTrigger, onRelease, onSelect, onToggleMode, onClear, onPitch }: Props) {
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target;
      return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    };
    const heldKeys = new Set<string>();
    const onDown = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const pad = KEY_TO_PAD[key];
      if (pad === undefined) return;
      if (heldKeys.has(key)) return;
      heldKeys.add(key);
      e.preventDefault();
      onTrigger(pad, 1);
    };
    const onUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const pad = KEY_TO_PAD[key];
      if (pad === undefined) return;
      heldKeys.delete(key);
      onRelease(pad);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [onTrigger, onRelease]);

  const activePads = new Set(state.activePads);

  return (
    <div className="pad-grid">
      {state.pads.map((p, idx) => (
        <PadButton
          key={p.index}
          pad={p}
          keyLabel={KEY_LABELS[idx]}
          selected={state.selectedPad === p.index}
          assigned={p.chopId !== null}
          active={activePads.has(p.index)}
          onTrigger={() => onTrigger(p.index, 1)}
          onRelease={() => onRelease(p.index)}
          onSelect={() => onSelect(p.index)}
          onToggleMode={() => onToggleMode(p.index)}
          onClear={() => onClear(p.index)}
          onPitch={(s) => onPitch(p.index, s)}
        />
      ))}
    </div>
  );
}

function PadButton({ pad, keyLabel, selected, assigned, active, onTrigger, onRelease, onSelect, onToggleMode, onClear, onPitch }: {
  pad: Pad;
  keyLabel: string;
  selected: boolean;
  assigned: boolean;
  active: boolean;
  onTrigger: () => void;
  onRelease: () => void;
  onSelect: () => void;
  onToggleMode: () => void;
  onClear: () => void;
  onPitch: (semitones: number) => void;
}) {
  const pitchRef = useRef<HTMLDivElement>(null);

  // Scroll wheel on pitch display adjusts semitones
  useEffect(() => {
    const el = pitchRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -1 : 1;
      onPitch(Math.max(-24, Math.min(24, pad.pitch + delta)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pad.pitch, onPitch]);

  return (
    <div
      className={[
        'pad',
        selected ? 'pad-selected' : '',
        assigned ? 'pad-assigned' : '',
        active ? 'pad-active' : '',
        `pad-mode-${pad.mode}`,
      ].filter(Boolean).join(' ')}
      style={{ '--pad-color': pad.color } as React.CSSProperties}
      onMouseDown={e => { e.preventDefault(); onTrigger(); }}
      onMouseUp={onRelease}
      onMouseLeave={onRelease}
      onContextMenu={e => { e.preventDefault(); onSelect(); }}
    >
      <div className="pad-key">{keyLabel}</div>
      <div className="pad-num">{String(pad.index + 1).padStart(2, '0')}</div>
      <div
        className="pad-mode"
        onClick={e => { e.stopPropagation(); onToggleMode(); }}
        title="Toggle one-shot / loop"
      >
        {pad.mode === 'loop' ? '∞' : '▶'}
      </div>
      <div
        ref={pitchRef}
        className={`pad-pitch ${pad.pitch !== 0 ? 'pad-pitch-active' : ''}`}
        onDoubleClick={e => { e.stopPropagation(); onPitch(0); }}
        title="Scroll to adjust pitch (semitones) • Double-click to reset"
      >
        {pad.pitch !== 0 ? (pad.pitch > 0 ? `+${pad.pitch}` : `${pad.pitch}`) : '♩'}
      </div>
      {assigned && (
        <button
          className="pad-clear"
          onClick={e => { e.stopPropagation(); onClear(); }}
          title="Clear assignment"
        >×</button>
      )}
    </div>
  );
}
