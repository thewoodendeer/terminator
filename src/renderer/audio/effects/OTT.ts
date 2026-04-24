/** Simplified OTT — 3-band upward+downward compressor with mix and depth knobs */
export class OTT {
  readonly input: GainNode;
  readonly output: GainNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private compressors: DynamicsCompressorNode[];
  private _mix = 0.5;
  private _depth = 0.8;
  private _bypassed = false;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    const wet = ctx.createGain();
    this.input.connect(this.dryGain);
    this.input.connect(wet);
    this.dryGain.connect(this.output);

    const bands = [
      buildBand(ctx, wet, 'lowpass', 250),
      buildBand(ctx, wet, null, 0, 250, 4000),
      buildBand(ctx, wet, 'highpass', 4000),
    ];

    this.compressors = bands.map(b => b.comp);
    for (const b of bands) b.makeup.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setMix(this._mix);
    this.setDepth(this._depth);
  }

  setMix(v: number) {
    this._mix = Math.max(0, Math.min(1, v));
    if (!this._bypassed) {
      this.dryGain.gain.value = 1 - this._mix;
      this.wetGain.gain.value = this._mix * 0.5;
    }
  }

  setDepth(v: number) {
    this._depth = Math.max(0, Math.min(1, v));
    // depth=0: light touch (ratio 2, threshold -10); depth=1: heavy OTT (ratio 20, threshold -40)
    const ratio     = 2  + this._depth * 18;
    const threshold = -10 - this._depth * 30;
    for (const comp of this.compressors) {
      comp.ratio.value     = ratio;
      comp.threshold.value = threshold;
    }
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.dryGain.gain.value = b ? 1 : 1 - this._mix;
    this.wetGain.gain.value = b ? 0 : this._mix * 0.5;
  }

  get mix()      { return this._mix; }
  get depth()    { return this._depth; }
  get bypassed() { return this._bypassed; }
}

function buildBand(
  ctx: AudioContext,
  source: AudioNode,
  type: BiquadFilterType | null,
  freq: number,
  loFreq = 0,
  hiFreq = 0
): { comp: DynamicsCompressorNode; makeup: GainNode } {
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value     = 6;
  comp.attack.value   = 0.003;
  comp.release.value  = 0.08;

  const makeup = ctx.createGain();
  makeup.gain.value = 1.5;

  if (type === 'lowpass' || type === 'highpass') {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    source.connect(f);
    f.connect(comp);
  } else {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = hiFreq;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = loFreq;
    source.connect(hp);
    hp.connect(lp);
    lp.connect(comp);
  }

  comp.connect(makeup);
  return { comp, makeup };
}
