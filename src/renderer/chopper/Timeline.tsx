import { ChopperState } from './ChopperEngine';

interface Props {
  state: ChopperState;
  onClear: () => void;
  onStartRecord: () => void;
  onStopRecord: () => void;
}

export function Timeline({ state, onClear, onStartRecord, onStopRecord }: Props) {
  const events = state.timeline;
  const totalDuration = events.length === 0
    ? 0
    : Math.max(...events.map(e => e.time + e.duration));
  const w = 1100;

  return (
    <div className="timeline">
      <div className="timeline-header">
        <span className="timeline-title">TIMELINE</span>
        <span className="timeline-count">{events.length} hits / {totalDuration.toFixed(1)}s</span>
        <div className="timeline-actions">
          {state.recording
            ? <button className="btn-rec on" onClick={onStopRecord}>● REC</button>
            : <button className="btn-rec" onClick={onStartRecord}>○ ARM</button>
          }
          <button className="btn-clear" onClick={onClear} disabled={events.length === 0}>CLEAR</button>
        </div>
      </div>
      <div className="timeline-canvas" style={{ width: w }}>
        {events.length === 0 && (
          <div className="timeline-empty">
            {state.recording
              ? 'Recording — trigger pads to add hits'
              : 'No timeline yet. ARM, then trigger pads to record an arrangement.'
            }
          </div>
        )}
        {events.map((e, i) => {
          const pad = state.pads[e.padIdx];
          const widthPct = totalDuration > 0 ? (e.duration / totalDuration) * 100 : 0;
          const leftPct  = totalDuration > 0 ? (e.time / totalDuration) * 100 : 0;
          const top = ((e.padIdx % 8) / 8) * 100;
          return (
            <div
              key={i}
              className="timeline-event"
              style={{
                left: `${leftPct}%`,
                top: `${top}%`,
                width: `${widthPct}%`,
                background: pad?.color ?? '#00ff88',
              }}
              title={`Pad ${e.padIdx + 1} @ ${e.time.toFixed(2)}s`}
            >
              {String(e.padIdx + 1).padStart(2, '0')}
            </div>
          );
        })}
      </div>
    </div>
  );
}
