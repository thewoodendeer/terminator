import { useRef, useEffect, useCallback } from 'react';
import { ChopperState } from './ChopperEngine';

interface Props {
  state: ChopperState;
  buffer: AudioBuffer | null;
  onSeekChop: (chopId: number) => void;             // single-click a chop region
  onAdjustChop: (chopId: number, side: 'start' | 'end', timeSec: number) => void;
  width?: number;
  height?: number;
}

const HANDLE_PX = 8;

export function WaveformView({ state, buffer, onSeekChop, onAdjustChop, width = 1100, height = 200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const draggingRef = useRef<{ chopId: number; side: 'start' | 'end' } | null>(null);

  // Recompute peaks when buffer changes
  useEffect(() => {
    if (!buffer) { peaksRef.current = null; return; }
    const cols = width;
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const samplesPerCol = Math.max(1, Math.floor(buffer.length / cols));
    const peaks = new Float32Array(cols * 2); // min, max per col
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
  }, [buffer, width]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;

    // Background
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
    const xOf = (t: number) => (t / dur) * W;

    // Chop region shading + boundaries
    state.chops.forEach((c, i) => {
      const x0 = xOf(c.start);
      const x1 = xOf(c.end);
      ctx.fillStyle = i % 2 === 0 ? 'rgba(0,255,136,0.04)' : 'rgba(0,200,255,0.04)';
      ctx.fillRect(x0, 0, x1 - x0, H);
    });

    // Waveform peaks
    const peaks = peaksRef.current;
    if (peaks) {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1;
      ctx.shadowBlur = 4;
      ctx.shadowColor = '#00ff88';
      ctx.beginPath();
      for (let c = 0; c < W; c++) {
        const mn = peaks[c * 2];
        const mx = peaks[c * 2 + 1];
        const yMn = (1 - (mn + 1) / 2) * H;
        const yMx = (1 - (mx + 1) / 2) * H;
        ctx.moveTo(c, yMn);
        ctx.lineTo(c, yMx);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Chop boundary lines + numbers
    state.chops.forEach((c, i) => {
      const x0 = xOf(c.start);
      ctx.strokeStyle = 'rgba(0,255,136,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, H); ctx.stroke();
      // Number tag
      const pad = state.pads.find(p => p.chopId === c.id);
      const label = String(i + 1).padStart(2, '0');
      ctx.fillStyle = pad ? pad.color : 'rgba(0,255,136,0.6)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x0 + 3, 3);
    });
    // Final boundary
    if (state.chops.length > 0) {
      const last = state.chops[state.chops.length - 1];
      const xEnd = xOf(last.end);
      ctx.strokeStyle = 'rgba(0,255,136,0.55)';
      ctx.beginPath(); ctx.moveTo(xEnd, 0); ctx.lineTo(xEnd, H); ctx.stroke();
    }

    // Selected pad's chop highlight
    const selPad = state.selectedPad !== null ? state.pads[state.selectedPad] : null;
    if (selPad?.chopId !== null && selPad?.chopId !== undefined) {
      const c = state.chops.find(x => x.id === selPad.chopId);
      if (c) {
        const x0 = xOf(c.start);
        const x1 = xOf(c.end);
        ctx.strokeStyle = '#cc00ff';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#cc00ff';
        ctx.strokeRect(x0 + 1, 1, x1 - x0 - 2, H - 2);
        ctx.shadowBlur = 0;
      }
    }

    // BPM ruler if known
    if (state.bpm > 0) {
      const beatSec = 60 / state.bpm;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let t = 0; t <= dur; t += beatSec) {
        const x = xOf(t);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
    }
  }, [state, buffer]);

  // Redraw on every state change
  useEffect(() => { draw(); }, [draw]);

  // Resize observer-lite — keep canvas resolution synced to its size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    draw();
  }, [width, height, draw]);

  // Mouse interactions: click a region → seek/select; drag near a boundary → move it.
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!buffer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const t = (px / canvas.width) * buffer.duration;

    // Check for boundary handle hit
    for (const c of state.chops) {
      const xs = (c.start / buffer.duration) * canvas.width;
      const xe = (c.end / buffer.duration) * canvas.width;
      if (Math.abs(px - xs) < HANDLE_PX) { draggingRef.current = { chopId: c.id, side: 'start' }; return; }
      if (Math.abs(px - xe) < HANDLE_PX) { draggingRef.current = { chopId: c.id, side: 'end' }; return; }
    }

    // Otherwise: click on a chop region → trigger pad-select / preview
    const hit = state.chops.find(c => t >= c.start && t < c.end);
    if (hit) onSeekChop(hit.id);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = draggingRef.current;
    if (!drag || !buffer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const t = Math.max(0, Math.min(buffer.duration, (px / canvas.width) * buffer.duration));
    onAdjustChop(drag.chopId, drag.side, t);
  };

  const handleMouseUp = () => { draggingRef.current = null; };

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="chopper-waveform"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    />
  );
}
