export type MidiNoteOnHandler  = (note: number, velocity: number) => void;
export type MidiNoteOffHandler = (note: number) => void;

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

export function midiNoteToName(note: number): string {
  const oct = Math.floor(note / 12) - 1;
  return `${NOTE_NAMES[note % 12]}${oct}`;
}

export class MidiInput {
  private access: MIDIAccess | null = null;
  private noteOnHandlers:  MidiNoteOnHandler[]  = [];
  private noteOffHandlers: MidiNoteOffHandler[] = [];
  private _inputCount = 0;

  async init(): Promise<void> {
    try {
      this.access = await (navigator as any).requestMIDIAccess({ sysex: false });
      this._wireInputs();
      this.access!.onstatechange = () => this._wireInputs();
    } catch (e) {
      console.warn('MIDI access denied or unavailable:', e);
    }
  }

  private _wireInputs(): void {
    if (!this.access) return;
    this._inputCount = 0;
    this.access.inputs.forEach(input => {
      this._inputCount++;
      input.onmidimessage = (ev: MIDIMessageEvent) => this._handle(ev);
    });
  }

  private _handle(ev: MIDIMessageEvent): void {
    const [status, note, velocity] = ev.data as unknown as number[];
    const cmd = status & 0xf0;
    if (cmd === 0x90 && velocity > 0) {
      for (const h of this.noteOnHandlers)  h(note, velocity);
    } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
      for (const h of this.noteOffHandlers) h(note);
    }
  }

  onNoteOn (h: MidiNoteOnHandler):  void { this.noteOnHandlers.push(h); }
  onNoteOff(h: MidiNoteOffHandler): void { this.noteOffHandlers.push(h); }

  get connected():  boolean { return this.access !== null; }
  get inputCount(): number  { return this._inputCount; }
}
