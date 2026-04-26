import { useRef, useEffect, useCallback, useState } from 'react';
import { ChopperState } from './ChopperEngine';

interface Props {
  state: ChopperState;
  buffer: AudioBuffer | null;
  onSeekChop: (chopId: number) => void;
  onAdjustChop: (chopId: number, side: 'start' | 'end', timeSec: number) => void;
  width?: number;
  height?: number;
}

const HANDLE_PX = 8;

export function WaveformView({ state, buffer, onSeekChop, onAdjustChop, width = 1100, height = 200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const draggingRef = useRef<{ chopId: number; side: 'start' | 'end' } | null>(null);
  const panRef = useRef<{ clientX: number; vs: number; ve: number; moved: boolean } | null>(null);

  // Zoom: 0..1 fractions of buffer duration
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);

  // Keep a ref to current view so event handlers don't close over stale state
  const viewRef = useRef({ viewStart: 0, viewEnd: 1 });
  viewRef.current = { viewStart, viewEnd };

  // Recompute peaks when buffer changes
  useEffect(() => {
    if (!buffer) { peaksRef.current = null; return; }
    const cols = width;
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const samplesPerCol = Math.max(1, Math.floor(buffer.length / cols));
    const peaks = new Float32Array(cols * 2);
    for (let c = 0; c < cols; c++) {
      const base = c * samplesPerCol;
      let mn = 0, mx = 0;
      for (let i = 0; i < samplesPerCol && base + i < buffer.length; i++) {
        const s = (ch0[base + i] + ch1[base + i]) * 0.5;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      peaks[c * 2] = mn;
      peaks[c * 2 + 1] = mx;
    }
    peaksRef.current = peaks;
    // Reset zoom on new buffer
    setViewStart(0);
    setViewEnd(1);
  }, [buffer, width]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, W, H);

    if (!buffer) {
      ctx.fillStyle = 'rgba(0,255,136,0.4)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO TRACK LOADED — pick a playlist and hit GET SAMPLE', W / 2, H / 2);
      return;
    }

    const dur = buffer.duration;
    const vs = viewStart, ve = viewEnd;
    const viewDur = (ve - vs) * dur;

    // Map buffer time → canvas X (within current view)
    const xOf = (t: number) => ((t / dur - vs) / (ve - vs)) * W;

    // Chop region shading
    state.chops.forEach((c, i) => {
      const x0 = xOf(c.start);
      const x1 = xOf(c.end);
      if (x1 < 0 || x0 > W) return;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(0,255,136,0.05)' : 'rgba(0,200,255,0.05)';
      ctx.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
    });

    // Waveform — draw only the visible portion
    const peaks = peaksRef.current;
    if (peaks) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1;
      ctx.shadowBlur = 4;
      ctx.shadowColor = '#00ff88';
      ctx.beginPath();
      const totalCols = peaks.length / 2;
      for (let c = 0; c < W; c++) {
        // Which fraction of the buffer does canvas column c correspond to?
        const frac = vs + (c / W) * (ve - vs);
        const col = Math.floor(frac * totalCols);
        if (col < 0 || col >= totalCols) continue;
        const mn = peaks[col * 2];
        const mx = peaks[col * 2 + 1];
        const yMn = (1 - (mn + 1) / 2) * H;
        const yMx = (1 - (mx + 1) / 2) * H;
        ctx.moveTo(c, yMn);
        ctx.lineTo(c, yMx);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Chop boundary lines + labels
    state.chops.forEach((c, i) => {
      const x0 = xOf(c.start);
      if (x0 >= 0 && x0 <= W) {
        ctx.strokeStyle = 'rgba(0,255,136,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
        const pad = state.pads.find(p => p.chopId === c.id);
        const label = String(i + 1).padStart(2, '0');
        ctx.fillStyle = pad ? pad.color : 'rgba(0,255,136,0.6)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, Math.max(2, x0 + 3), 3);
      }
    });
    // Final chop end line
    if (state.chops.length > 0) {
      const xEnd = xOf(state.chops[state.chops.length - 1].end);
      if (xEnd >= 0 && xEnd <= W) {
        ctx.strokeStyle = 'rgba(0,255,136,0.6)';
        ctx.beginPath(); ctx.moveTo(xEnd, 0); ctx.lineTo(xEnd, H); ctx.stroke();
      }
    }

    // Selected pad highlight
    const selPad = state.selectedPad !== null ? state.pads[state.selectedPad] : null;
    if (selPad?.chopId !== null && selPad?.chopId !== undefined) {
      const c = state.chops.find(x => x.id === selPad.chopId);
      if (c) {
        const x0 = xOf(c.start), x1 = xOf(c.end);
        ctx.strokeStyle = '#cc00ff';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8; ctx.shadowColor = '#cc00ff';
        ctx.strokeRect(Math.max(1, x0 + 1), 1, x1 - x0 - 2, H - 2);
        ctx.shadowBlur = 0;
      }
    }

    // Playback cursor
    if (state.playbackPos >= 0 && state.playbackPos <= dur) {
      const xCursor = xOf(state.playbackPos);
      if (xCursor >= 0 && xCursor <= W) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 6; ctx.shadowColor = '#ffffff';
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(xCursor, 0); ctx.lineTo(xCursor, H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      }
    }

    // BPM grid lines
    if (state.bpm > 0) {
      const beatSec = 60 / state.bpm;
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      const startBeat = Math.floor((vs * dur) / beatSec);
      for (let b = startBeat; b * beatSec <= ve * dur; b++) {
        const x = xOf(b * beatSec);
        if (x < 0 || x > W) continue;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }

    // Zoom indicator bar
    if (ve - vs < 0.99) {
      ctx.fillStyle = 'rgba(0,255,136,0.15)';
      ctx.fillRect(vs * W, H - 4, (ve - vs) * W, 4);
      ctx.fillStyle = 'rgba(0,255,136,0.5)';
      ctx.fillRect(vs * W, H - 4, 2, 4);
      ctx.fillRect(ve * W - 2, H - 4, 2, 4);
    }

    // View duration label
    ctx.fillStyle = 'rgba(0,255,136,0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${viewDur.toFixed(2)}s view`, W - 4, H - 6);
  }, [state, buffer, viewStart, viewEnd]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    draw();
  }, [width, height, draw]);

  // Scroll wheel: zoom centered on mouse position
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!buffer) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseNorm = (e.clientX - rect.left) / rect.width; // 0..1 in canvas
      // What fraction of the buffer is under the mouse?
      const anchor = viewStart + mouseNorm * (viewEnd - viewStart);

      const zoomFactor = e.deltaY > 0 ? 1.25 : 0.8;
      const curSpan = viewEnd - viewStart;
      const newSpan = Math.min(1, Math.max(0.005, curSpan * zoomFactor));

      let ns = anchor - mouseNorm * newSpan;
      let ne = ns + newSpan;
      if (ns < 0) { ns = 0; ne = newSpan; }
      if (ne > 1) { ne = 1; ns = 1 - newSpan; }
      setViewStart(ns);
      setViewEnd(ne);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [buffer, viewStart, viewEnd]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!buffer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;

    // Check boundary handles first
    for (const c of state.chops) {
      const xs = ((c.start / buffer.duration - viewStart) / (viewEnd - viewStart)) * canvas.width;
      const xe = ((c.end   / buffer.duration - viewStart) / (viewEnd - viewStart)) * canvas.width;
      if (Math.abs(px - xs) < HANDLE_PX) { draggingRef.current = { chopId: c.id, side: 'start' }; return; }
      if (Math.abs(px - xe) < HANDLE_PX) { draggingRef.current = { chopId: c.id, side: 'end' }; return; }
    }

    // Start pan / click tracking
    panRef.current = { clientX: e.clientX, vs: viewStart, ve: viewEnd, moved: false };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Boundary drag takes priority
    const drag = draggingRef.current;
    if (drag && buffer) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const frac = Math.max(0, Math.min(1, viewStart + (px / canvas.width) * (viewEnd - viewStart)));
      const t = frac * buffer.duration;
      onAdjustChop(drag.chopId, drag.side, t);
      return;
    }

    // Pan drag
    const pan = panRef.current;
    if (!pan || !buffer) return;
    const dx = e.clientX - pan.clientX;
    if (Math.abs(dx) > 3) pan.moved = true;
    if (!pan.moved) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.cursor = 'grabbing';
    const rect = canvas.getBoundingClientRect();
    const span = pan.ve - pan.vs;
    const shift = -(dx / rect.width) * span;
    let ns = pan.vs + shift;
    let ne = pan.ve + shift;
    if (ns < 0) { ns = 0; ne = span; }
    if (ne > 1) { ne = 1; ns = 1 - span; }
    setViewStart(ns);
    setViewEnd(ne);
    pan.clientX = e.clientX;
    pan.vs = ns;
    pan.ve = ne;
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    draggingRef.current = null;
    const pan = panRef.current;
    panRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
    if (pan && !pan.moved && buffer) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const { viewStart: vs, viewEnd: ve } = viewRef.current;
      const frac = vs + (px / canvas.width) * (ve - vs);
      const t = frac * buffer.duration;
      const hit = state.chops.find(c => t >= c.start && t < c.end);
      if (hit) onSeekChop(hit.id);
    }
  };

  const resetZoom = () => { setViewStart(0); setViewEnd(1); };
  const zoomIn = () => {
    const mid = (viewStart + viewEnd) / 2;
    const span = (viewEnd - viewStart) * 0.6;
    const ns = Math.max(0, mid - span / 2);
    const ne = Math.min(1, ns + span);
    setViewStart(ns); setViewEnd(ne);
  };
  const zoomOut = () => {
    const mid = (viewStart + viewEnd) / 2;
    const span = Math.min(1, (viewEnd - viewStart) * 1.6);
    const ns = Math.max(0, mid - span / 2);
    const ne = Math.min(1, ns + span);
    setViewStart(ns); setViewEnd(ne);
  };

  return (
    <div className="waveform-wrap">
      <div className="waveform-zoom-bar">
        <button className="btn-zoom" onClick={zoomIn} title="Zoom in (scroll wheel also works)">+</button>
        <button className="btn-zoom" onClick={zoomOut} title="Zoom out">−</button>
        <button className="btn-zoom" onClick={resetZoom} title="Reset zoom">FIT</button>
        <span className="zoom-level">{Math.round(100 / (viewEnd - viewStart))}×</span>
      </div>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="chopper-waveform"
        style={{ cursor: 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={e => handleMouseUp(e)}
      />
    </div>
  );
}
