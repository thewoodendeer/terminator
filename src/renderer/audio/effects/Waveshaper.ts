export class Waveshaper {
  readonly input: GainNode;
  readonly output: GainNode;
  private shaper: WaveShaperNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private _drive = 0.5;
  private _mix = 0.5;
  private _bypassed = false;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();

    // Parallel dry/wet
    this.input.connect(this.dryGain);
    this.input.connect(this.shaper);
    this.shaper.connect(this.wetGain);
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);

    this.setDrive(this._drive);
    this.setMix(this._mix);
  }

  setDrive(amount: number) {
    this._drive = Math.max(0, Math.min(1, amount));
    this.shaper.curve = makeSoftClipCurve(this._drive);
  }

  setMix(mix: number) {
    this._mix = Math.max(0, Math.min(1, mix));
    if (!this._bypassed) {
      this.dryGain.gain.value = 1 - this._mix;
      this.wetGain.gain.value = this._mix;
    }
  }

  setBypassed(b: boolean) {
    this._bypassed = b;
    this.dryGain.gain.value = b ? 1 : 1 - this._mix;
    this.wetGain.gain.value = b ? 0 : this._mix;
  }

  get drive() { return this._drive; }
  get mix() { return this._mix; }
  get bypassed() { return this._bypassed; }
}

function makeSoftClipCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve: Float32Array<ArrayBuffer> = new Float32Array(n);
  const k = drive * 100 + 1;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
