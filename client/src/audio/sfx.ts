/**
 * Procedural sound effects via the Web Audio API — no audio assets required.
 * Everything is synthesized from oscillators + filtered noise so the game ships
 * with zero binary sound files. Lazily creates the AudioContext and must be
 * resumed from a user gesture (see GameScene.create) before it will play.
 */

type OscType = "sine" | "square" | "sawtooth" | "triangle";

class Sfx {
  enabled = true;
  private ctx?: AudioContext;
  private master?: GainNode;
  private noiseBuffer?: AudioBuffer;

  private ensure(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
    // One second of white noise, reused for every percussive/whoosh effect.
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ctx = ctx;
    this.master = master;
    this.noiseBuffer = buffer;
    return ctx;
  }

  /** Resume the audio context from a user gesture; browsers start it suspended. */
  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === "suspended") void ctx.resume();
  }

  private now() {
    return this.ctx!.currentTime;
  }

  /** A single pitched blip with an attack/decay envelope, optionally gliding in pitch. */
  private tone(freq: number, dur: number, type: OscType, gain: number, glideTo?: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.enabled || !this.master) return;
    const t = this.now() + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.3));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A filtered noise burst — the basis for whooshes, impacts and booms. */
  private noise(dur: number, gain: number, filterHz: number, type: BiquadFilterType, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.enabled || !this.master || !this.noiseBuffer) return;
    const t = this.now() + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterHz;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  swing() {
    this.noise(0.16, 0.35, 1400, "bandpass");
    this.tone(520, 0.14, "triangle", 0.12, 200);
  }

  hit() {
    this.noise(0.12, 0.5, 2600, "highpass");
    this.tone(180, 0.16, "square", 0.28, 70);
  }

  hurt() {
    this.tone(200, 0.28, "sawtooth", 0.3, 90);
    this.noise(0.14, 0.3, 900, "lowpass");
  }

  roll() {
    this.noise(0.3, 0.28, 700, "bandpass");
  }

  pickup() {
    this.tone(660, 0.1, "square", 0.22);
    this.tone(990, 0.12, "square", 0.2, undefined, 0.09);
  }

  bossTelegraph() {
    this.tone(90, 0.32, "sawtooth", 0.22, 130);
  }

  bossAttack() {
    this.noise(0.34, 0.55, 500, "lowpass");
    this.tone(70, 0.4, "square", 0.32, 45);
  }

  /** Heavy, wet crash for the slime's ground-pound landing. */
  bossJump() {
    this.noise(0.45, 0.62, 320, "lowpass"); // deep impact boom
    this.tone(58, 0.5, "square", 0.34, 34); // sub thump
    this.noise(0.16, 0.4, 3200, "highpass", 0.02); // splattering debris
  }

  /** Bubbly rising gurgle for the slime's summon. */
  bossSummon() {
    this.tone(240, 0.34, "sine", 0.24, 660); // gloopy rise
    this.noise(0.26, 0.3, 1300, "bandpass");
    this.tone(150, 0.26, "square", 0.2, 90, 0.09);
  }

  phase() {
    this.tone(160, 0.5, "sawtooth", 0.3, 640);
    this.noise(0.4, 0.4, 1200, "bandpass");
  }

  /** Sharp arcane crackle for a projectile launch. */
  cast() {
    this.noise(0.12, 0.3, 2400, "bandpass");
    this.tone(760, 0.18, "sawtooth", 0.16, 320);
  }

  /** Rumbling burst for a ground-target eruption. */
  eruption() {
    this.noise(0.3, 0.5, 420, "lowpass");
    this.tone(110, 0.32, "square", 0.26, 60);
    this.noise(0.12, 0.3, 2800, "highpass", 0.04);
  }

  /** Airy warp zip for a teleporting blink. */
  blink() {
    this.tone(880, 0.16, "sine", 0.18, 220);
    this.noise(0.14, 0.22, 1800, "bandpass");
  }

  /** Soft rising chime for drinking a potion / being healed. */
  heal() {
    this.tone(520, 0.16, "sine", 0.22, 780);
    this.tone(780, 0.2, "sine", 0.16, 1040, 0.08);
  }

  /** Dull low thunk for a denied action (not enough stamina). */
  deny() {
    this.tone(140, 0.09, "square", 0.16, 100);
  }

  death() {
    this.tone(320, 0.7, "sawtooth", 0.3, 70);
    this.tone(160, 0.9, "square", 0.25, 50, 0.12);
  }

  victory() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => this.tone(f, 0.3, "triangle", 0.24, undefined, i * 0.12));
  }
}

export const sfx = new Sfx();
