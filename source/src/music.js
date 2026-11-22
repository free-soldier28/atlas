// Ambient music: a calm chiptune loop synthesised with the Web Audio API, no audio files. Four voices as on an old
// sound chip: a pulse-wave melody, a square-wave arpeggio, a triangle bass and a faint noise shimmer, through a gentle
// low-pass and an echo. The 32-bar pattern is fixed; nothing in the scene changes it.
// Nothing runs per frame. The audio graph is built once, on the first click, tap or key (browsers allow sound only
// after one), and each voice is one oscillator that plays for ever. A timer four times a second writes the next notes
// as gain and pitch automation on the audio clock, 1.5 s ahead, at times computed from the loop count, so no node is
// created after the start, the loop point is just the next note and nothing drifts. M mutes (remembered); muted or
// with the tab hidden the audio clock is suspended and the timer stopped.
{
  // tempo, key and loudness: the numbers to change
  const BPM = 70;                        // beats a minute; the notes and the echo follow
  const ROOT = 62;                       // the key's tonic as a MIDI note (62 = D4, 60 = C4, 65 = F4)
  const SCALE = [0, 2, 4, 6, 7, 9, 11];  // Lydian. [0, 2, 4, 7, 9] is major pentatonic: the pattern is in scale steps
  const VOLUME = 0.3;                    // master gain, 0-1
  const CUTOFF = 2600;                   // the low-pass, Hz: lower is softer
  const ECHO = [0.75, 0.35, 0.3];        // echo: delay in beats (a dotted eighth), feedback, level
  const LEVEL = [0.11, 0.09, 0.3, 0.05]; // melody, arpeggio, bass, shimmer

  // the pattern, on a grid of eighth notes (8 a bar). Chords are scale steps, one a bar, the 16 bars played twice
  const CHORDS = [0, 0, 1, 1, 2, 2, 1, 1, 5, 5, 4, 4, 0, 0, 1, 1]; // I II iii II vi V I II
  const ARP = [[0, 2, 4, 7, 8, 7, 4, 2], [0, 2, 4, 7, 9, 7, 4, 2]]; // steps above the chord, bars 1-16 and 17-32
  // melody: start (eighths from the loop's start), scale step above ROOT + 12, length (eighths); one note at a time
  const MELODY = [
    2, 4, 6, 8, 2, 4, 12, 1, 4, 16, 3, 10, 28, 5, 4, 32, 4, 6, 38, 2, 2, 40, 1, 8, 48, 3, 6, 54, 4, 2, 56, 5, 8,
    66, 7, 6, 72, 6, 4, 76, 5, 4, 80, 4, 8, 88, 6, 4, 92, 8, 4, 98, 7, 6, 104, 4, 8, 112, 3, 12, 124, 1, 4,
    130, 9, 6, 136, 8, 4, 140, 7, 4, 144, 8, 8, 152, 10, 8, 160, 9, 10, 172, 6, 4, 176, 8, 6, 182, 6, 2, 184, 5, 8,
    194, 7, 6, 200, 9, 8, 208, 8, 4, 212, 6, 4, 216, 4, 8, 226, 2, 6, 232, 4, 8, 240, 3, 8, 248, 1, 6,
  ];
  const BARS = 32, LOOP = BARS * 8, STEP = 30 / BPM, AHEAD = 1.5;

  // every note of the loop, sorted by time: [eighth, voice (0 melody, 1 arpeggio, 2 bass, 3 shimmer), MIDI note, eighths, level]
  const deg = (d) => SCALE[d % SCALE.length] + 12 * Math.floor(d / SCALE.length);
  const ev = [];
  for (let i = 0; i < MELODY.length; i += 3) ev.push([MELODY[i], 0, ROOT + 12 + deg(MELODY[i + 1]), MELODY[i + 2], LEVEL[0]]);
  for (let b = 0; b < BARS; b++) {
    const c = CHORDS[b % 16], lo = c >= 4 ? c - SCALE.length : c, s = b * 8; // high chords' arpeggios an octave down
    for (let k = 0; k < 8; k++) ev.push([s + k, 1, ROOT + deg(lo + SCALE.length + ARP[b >> 4][k]) - 12, 1, LEVEL[1] * (k ? k < 4 ? 0.8 : 0.65 : 1)]);
    // bass: the root for a bar, then root and fifth in the chord's second bar
    if (b % 2 === 0) ev.push([s, 2, ROOT - 24 + deg(c), 8, LEVEL[2]]);
    else ev.push([s, 2, ROOT - 24 + deg(c), 4, LEVEL[2] * 0.85], [s + 4, 2, ROOT - 24 + deg(c + 4) - (c + 4 >= SCALE.length ? 12 : 0), 4, LEVEL[2] * 0.7]);
    if (b % 2 === 0) ev.push([s, 3, 0, 16, LEVEL[3] * (b % 4 ? 0.6 : 1)]); // shimmer: a swell every two bars
  }
  ev.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const NE = ev.length, ES = new Int16Array(NE), EV = new Uint8Array(NE), EL = new Uint8Array(NE), EF = new Float32Array(NE), EA = new Float32Array(NE);
  ev.forEach((e, i) => { ES[i] = e[0]; EV[i] = e[1]; EF[i] = 440 * 2 ** ((e[2] - 69) / 12); EL[i] = e[3]; EA[i] = e[4]; });

  let ctx = null, out, osc, amp, vib, timer = 0, off = 0, t0 = 0, n = 0, i = 0, muted = false;
  try { muted = localStorage.atlantisMute === '1'; } catch {}

  // one note: pitch set while the voice is silent (every envelope ends at zero before the next note starts), then
  // straight-line envelopes inside the note's own span, so no two notes' automation interleave and nothing clicks
  const play = (k, t) => {
    const v = EV[k], d = EL[k] * STEP, a = EA[k], g = amp[v].gain;
    if (v < 3) osc[v].frequency.setValueAtTime(EF[k], t);
    g.setValueAtTime(0, t);
    if (v === 1) { // arpeggio: a pluck
      g.linearRampToValueAtTime(a, t + 0.005); g.linearRampToValueAtTime(a * 0.4, t + 0.08);
      g.linearRampToValueAtTime(a * 0.12, t + d * 0.6); g.linearRampToValueAtTime(0, t + d * 0.95);
    } else if (v === 3) { // shimmer: a slow swell
      g.linearRampToValueAtTime(a, t + d * 0.5); g.linearRampToValueAtTime(0, t + d * 0.98);
    } else { // melody and bass: soft attack, decay, sustain, release
      const r = Math.min(0.4, d * 0.3);
      g.linearRampToValueAtTime(a, t + 0.04); g.linearRampToValueAtTime(a * 0.65, t + Math.min(0.45, d - r));
      g.setValueAtTime(a * 0.65, t + d - r); g.linearRampToValueAtTime(0, t + d * 0.99);
      if (v === 0) { vib.setValueAtTime(0, t); vib.linearRampToValueAtTime(0, t + d * 0.3); vib.linearRampToValueAtTime(Math.min(12, d * 5), t + d * 0.99); } // delayed vibrato, cents
    }
  };
  // write every note that starts within AHEAD seconds; a note already due (the page stalled longer than that) is
  // skipped rather than played late, so a stall leaves a rest, never a click
  const tick = () => {
    const now = ctx.currentTime, until = now + AHEAD;
    for (;;) {
      const t = t0 + (n * LOOP + ES[i]) * STEP;
      if (t >= until) break;
      if (t > now + 0.01) play(i, t);
      if (++i === NE) { i = 0; n++; }
    }
  };

  const build = () => {
    ctx = new AudioContext({ latencyHint: 'playback' });
    out = new GainNode(ctx, { gain: 0 }); out.connect(ctx.destination);
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: CUTOFF, Q: -3 }); lp.connect(out); // Q in dB: no resonance
    const dl = new DelayNode(ctx, { delayTime: ECHO[0] * 60 / BPM, maxDelayTime: 5 }), damp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1800, Q: -3 });
    const fb = new GainNode(ctx, { gain: ECHO[1] }), wet = new GainNode(ctx, { gain: ECHO[2] });
    lp.connect(dl); dl.connect(damp); damp.connect(fb); fb.connect(dl); damp.connect(wet); wet.connect(out);
    // a 25% pulse for the melody (brighter than the square), as a Fourier series
    const re = new Float32Array(64), im = new Float32Array(64);
    for (let h = 1; h < 64; h++) re[h] = Math.sin(Math.PI * h * 0.25) * 2 / (Math.PI * h);
    osc = [new OscillatorNode(ctx, { periodicWave: new PeriodicWave(ctx, { real: re, imag: im }) }), new OscillatorNode(ctx, { type: 'square' }), new OscillatorNode(ctx, { type: 'triangle' })];
    // shimmer: two seconds of looped white noise, band-passed around 4 kHz
    const nb = new AudioBuffer({ length: 2 * ctx.sampleRate, sampleRate: ctx.sampleRate }), nd = nb.getChannelData(0);
    for (let k = 0, s = 1; k < nd.length; k++) { s = (Math.imul(s, 1664525) + 1013904223) | 0; nd[k] = s / 2147483648; }
    const noise = new AudioBufferSourceNode(ctx, { buffer: nb, loop: true }), bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 4000, Q: 0.8 });
    noise.connect(bp);
    amp = [0.2, -0.25, 0, 0].map((p, v) => { const g = new GainNode(ctx, { gain: 0 }), s = new StereoPannerNode(ctx, { pan: p }); (v < 3 ? osc[v] : bp).connect(g); g.connect(s); s.connect(lp); return g; });
    const lfo = new OscillatorNode(ctx, { frequency: 5.5 }), depth = new GainNode(ctx, { gain: 0 }); lfo.connect(depth); depth.connect(osc[0].detune); vib = depth.gain;
    for (const o of [...osc, noise, lfo]) o.start();
    t0 = ctx.currentTime + 0.2;
  };

  // play while not muted and the tab is visible; otherwise fade out, then suspend the audio clock (where the music
  // waits) and stop the timer
  const apply = () => {
    clearTimeout(off);
    const now = ctx.currentTime;
    if (!muted && !document.hidden) {
      if (ctx.state !== 'running') ctx.resume().catch(() => 0);
      out.gain.setTargetAtTime(VOLUME, now, 0.1);
      if (!timer) { tick(); timer = setInterval(tick, 250); }
    } else {
      out.gain.setTargetAtTime(0, now, 0.03);
      off = setTimeout(() => { if (muted || document.hidden) { ctx.suspend(); clearInterval(timer); timer = 0; } }, 300);
    }
  };
  const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'keydown'];
  const gesture = () => {
    if (!ctx) { try { build(); } catch (e) { console.warn('music: ' + e.message); ctx = null; GESTURES.forEach((g) => removeEventListener(g, gesture, true)); return; } }
    apply();
    if (ctx.state === 'running' || muted) GESTURES.forEach((g) => removeEventListener(g, gesture, true));
  };
  if (!AUTO) {
    GESTURES.forEach((g) => addEventListener(g, gesture, true));
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      muted = !muted; try { localStorage.atlantisMute = muted ? '1' : ''; } catch {}
      if (ctx) apply();
    }, true);
    document.addEventListener('visibilitychange', () => { if (ctx) apply(); });
  }
}
