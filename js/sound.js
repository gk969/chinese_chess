/**
 * 全部音效实时合成,不带音频文件,整个项目还是一个可以直接双击的静态目录。
 * AudioContext 要等第一次手势才建 —— 浏览器在那之前会拒绝启动。
 */
class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.wet = null;
    this.noise = null;
    this.enabled = true;
    this.volume = 0.7;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.gainValue();
    this.master.connect(ctx.destination);

    // 程序生成的卷积混响:一段指数衰减的白噪声当脉冲响应。
    const ir = ctx.createBuffer(2, Math.round(ctx.sampleRate * 1.4), ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const t = i / d.length;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * (ch ? 0.8 : 1);
      }
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.26;
    this.wet.connect(verb);
    verb.connect(this.master);

    const nb = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.25), ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noise = nb;
  }

  gainValue() {
    return this.enabled ? Math.pow(this.volume, 1.6) * 0.9 : 0;
  }

  setEnabled(v) {
    this.enabled = v;
    if (this.master) this.master.gain.value = this.gainValue();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.gainValue();
  }

  get ready() {
    return !!this.ctx && this.enabled && this.ctx.state === 'running';
  }

  tone(freq, t0, dur, type, peak, sendWet = 0) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    if (sendWet) {
      const s = ctx.createGain();
      s.gain.value = sendWet;
      g.connect(s);
      s.connect(this.wet);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    return osc;
  }

  /** 带通噪声瞬态:木头碰木头的那一下"嗒"。 */
  noiseHit(t0, freq, q, peak, dur) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.12);
  }

  /** 选中:比落子轻得多,只是"拿起来"的一声。 */
  select() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + 0.001;
    this.noiseHit(t0, 3200 * (0.96 + Math.random() * 0.08), 1.6, 0.09, 0.04);
    this.tone(1180, t0, 0.05, 'triangle', 0.06);
  }

  /** 落子:红子略亮、黑子略闷,±6% 随机化避免机械重复。 */
  move(side) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.001;
    const bright = (side === RED ? 1900 : 1500) * (0.94 + Math.random() * 0.12);
    this.noiseHit(t0, bright, 1.1, 0.42, 0.09);
    this.tone(150 * (0.95 + Math.random() * 0.1), t0, 0.14, 'sine', 0.3);
    this.tone(78, t0, 0.1, 'triangle', 0.14);
  }

  /** 吃子:先一记脆的,再压一个更低更长的闷响。 */
  capture(side) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.001;
    this.noiseHit(t0, 2600 * (0.94 + Math.random() * 0.12), 1.4, 0.4, 0.06);
    this.noiseHit(t0 + 0.045, 900 * (0.94 + Math.random() * 0.12), 2.2, 0.34, 0.13);
    this.tone(210 * (0.96 + Math.random() * 0.08), t0, 0.12, 'square', 0.12);
    this.tone(66, t0 + 0.02, 0.26, 'triangle', 0.26, 0.2);
  }

  /** 将军:两声上行的短促警示,比落子明显但不至于刺耳。 */
  check() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + 0.001;
    this.tone(880, t0, 0.12, 'square', 0.13, 0.3);
    this.tone(1320, t0 + 0.09, 0.14, 'square', 0.11, 0.3);
    this.tone(196, t0, 0.2, 'triangle', 0.12);
  }

  reject() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + 0.001;
    this.tone(150, t0, 0.1, 'square', 0.16);
    this.tone(112, t0 + 0.11, 0.16, 'square', 0.16);
  }

  undo() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + 0.001;
    const o = this.tone(700, t0, 0.16, 'triangle', 0.2);
    o.frequency.exponentialRampToValueAtTime(280, t0 + 0.15);
  }

  win() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + 0.05;
    // D 宫五声上行,收在高音上。
    const notes = [587.33, 659.25, 783.99, 880, 1046.5, 1174.66];
    notes.forEach((f, i) => {
      this.tone(f, t0 + i * 0.11, 0.55, 'triangle', 0.22, 0.5);
      this.tone(f * 2, t0 + i * 0.11, 0.3, 'sine', 0.07, 0.4);
    });
    this.tone(293.66, t0, 1.5, 'sine', 0.16, 0.5);
    this.tone(440, t0 + 0.55, 1.1, 'triangle', 0.12, 0.6);
  }

  lose() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + 0.05;
    const notes = [440, 392, 311.13, 233.08];
    notes.forEach((f, i) => {
      this.tone(f, t0 + i * 0.17, 0.7, 'sine', 0.22, 0.45);
    });
    this.tone(110, t0 + 0.5, 1.4, 'triangle', 0.16, 0.3);
  }

  draw() {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime + 0.05;
    this.tone(392, t0, 0.6, 'sine', 0.2, 0.4);
    this.tone(392, t0 + 0.24, 0.6, 'sine', 0.2, 0.4);
  }
}
