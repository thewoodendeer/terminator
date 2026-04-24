import { useState } from 'react';
import { WAVBitDepth, ExportFormat } from '../audio/StemExporter';

interface Props {
  masterVolume:   number;
  limiterEnabled: boolean;
  onMasterVolume: (v: number) => void;
  onLimiter:      (v: boolean) => void;
  onExportStems:  (format: ExportFormat, bitDepth: WAVBitDepth, dry: boolean) => void;
  onExportMaster: (format: ExportFormat, bitDepth: WAVBitDepth, dry: boolean) => void;
}

export function MasterSection({ masterVolume, limiterEnabled, onMasterVolume, onLimiter, onExportStems, onExportMaster }: Props) {
  const [format, setFormat]       = useState<ExportFormat>('wav');
  const [bitDepth, setBitDepth]   = useState<WAVBitDepth>(24);
  const [dry, setDry]             = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExportStems = async () => {
    setExporting(true);
    try { await onExportStems(format, bitDepth, dry); }
    finally { setExporting(false); }
  };

  const handleExportMaster = async () => {
    setExporting(true);
    try { await onExportMaster(format, bitDepth, dry); }
    finally { setExporting(false); }
  };

  return (
    <div className="master-section">
      <div className="master-title">MASTER</div>

      <div className="master-controls">
        <label className="ctrl-group">
          <span className="ctrl-label">LEVEL</span>
          <input type="range" className="fader master-fader" min={0} max={1} step={0.01}
            value={masterVolume}
            onChange={e => onMasterVolume(Number(e.target.value))}
            onDoubleClick={() => onMasterVolume(0.85)}
            title="Double-click to reset" />
          <span className="ctrl-value">{Math.round(masterVolume * 100)}</span>
        </label>

        <div className="vu-meter">
          <div className="vu-bar vu-l" style={{ height: `${masterVolume * 80}%` }} />
          <div className="vu-bar vu-r" style={{ height: `${masterVolume * 75}%` }} />
        </div>

        <button
          className={`btn btn-limiter ${limiterEnabled ? 'active' : ''}`}
          onClick={() => onLimiter(!limiterEnabled)}
          title="Master limiter"
        >
          {limiterEnabled ? '⬛ LIMIT ON' : '⬜ LIMIT OFF'}
        </button>
      </div>

      <div className="export-section">
        <div className="export-title">EXPORT</div>

        <div className="export-opts">
          <label className="ctrl-group">
            <span className="ctrl-label">FORMAT</span>
            <select className="ctrl-select" value={format} onChange={e => setFormat(e.target.value as ExportFormat)}>
              <option value="wav">WAV</option>
              <option value="mp3">MP3 ⚠</option>
              <option value="flac">FLAC ⚠</option>
            </select>
          </label>

          {format === 'wav' && (
            <label className="ctrl-group">
              <span className="ctrl-label">BIT DEPTH</span>
              <select className="ctrl-select" value={bitDepth} onChange={e => setBitDepth(Number(e.target.value) as WAVBitDepth)}>
                <option value={8}>8-bit</option>
                <option value={16}>16-bit</option>
                <option value={24}>24-bit</option>
                <option value={32}>32f</option>
              </select>
            </label>
          )}

          <label className="ctrl-check">
            <input type="checkbox" checked={dry} onChange={e => setDry(e.target.checked)} />
            <span>DRY EXPORT</span>
          </label>
        </div>

        <div className="export-btns">
          <button className={`btn btn-export ${exporting ? 'loading' : ''}`} onClick={handleExportStems} disabled={exporting}>
            {exporting ? 'RENDERING…' : '⬇ STEMS'}
          </button>
          <button className={`btn btn-export ${exporting ? 'loading' : ''}`} onClick={handleExportMaster} disabled={exporting}>
            {exporting ? 'RENDERING…' : '⬇ MASTER'}
          </button>
        </div>
      </div>
    </div>
  );
}
