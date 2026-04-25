import { useEffect } from 'react';
import { ChopperState, Pad } from './ChopperEngine';

interface Props {
  state: ChopperState;
  onTrigger: (padIdx: number, velocity?: number) => void;
  onRelease: (padIdx: number) => void;
  onSelect: (padIdx: number) => void;
  onToggleMode: (padIdx: number) => void;
  onClear: (padIdx: number) => void;
}

// Keyboard layout — top row of grid maps to top row of keys.
// Grid (visual top→bottom): row 0 = pads 0..3, row 1 = 4..7, row 2 = 8..11, row 3 = 12..15
const KEY_TO_PAD: Record<string, number> = {
  '1': 0, '2': 1, '3': 2, '4': 3,
  'q': 4, 'w': 5, 'e': 6, 'r': 7,
  'a': 8, 's': 9, 'd': 10, 'f': 11,
  'z': 12, 'x': 13, 'c': 14, 'v': 15,
};
const KEY_LABELS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];

export function PadGrid({ state, onTrigger, onRelease, onSelect, onToggleMode, onClear }: Props) {
  // Keyboard handler — register at window level so pads trigger no matter what's focused
  // (except when typing into a text input).
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
      if (heldKeys.has(key)) return; // ignore key repeat
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

  return (
    <div className="pad-grid">
      {state.pads.map((p, idx) => (
        <PadButton
          key={p.index}
          pad={p}
          keyLabel={KEY_LABELS[idx]}
          selected={state.selectedPad === p.index}
          assigned={p.chopId !== null}
          onTrigger={() => onTrigger(p.index, 1)}
          onRelease={() => onRelease(p.index)}
          onSelect={() => onSelect(p.index)}
          onToggleMode={() => onToggleMode(p.index)}
          onClear={() => onClear(p.index)}
        />
      ))}
    </div>
  );
}

function PadButton({ pad, keyLabel, selected, assigned, onTrigger, onRelease, onSelect, onToggleMode, onClear }: {
  pad: Pad;
  keyLabel: string;
  selected: boolean;
  assigned: boolean;
  onTrigger: () => void;
  onRelease: () => void;
  onSelect: () => void;
  onToggleMode: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className={`pad ${selected ? 'pad-selected' : ''} ${assigned ? 'pad-assigned' : ''} pad-mode-${pad.mode}`}
      style={{ '--pad-color': pad.color } as React.CSSProperties}
      onMouseDown={e => { e.preventDefault(); onTrigger(); }}
      onMouseUp={onRelease}
      onMouseLeave={onRelease}
      onContextMenu={e => { e.preventDefault(); onSelect(); }}
      title={`Click: trigger | Right-click: select for assign | Pad ${pad.index + 1}`}
    >
      <div className="pad-key">{keyLabel}</div>
      <div className="pad-num">{String(pad.index + 1).padStart(2, '0')}</div>
      <div className="pad-mode" onClick={e => { e.stopPropagation(); onToggleMode(); }} title="Toggle one-shot / loop">
        {pad.mode === 'loop' ? '∞' : '▶'}
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
