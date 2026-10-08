/**
 * 渲染:棋盘缓存层、棋子精灵、走子/吃子/将军/胜负动画。
 * 所有尺寸都从 this.cell 推导,所以窗口变大时棋盘和棋子一起等比放大。
 */

const MIN_CELL = 34;      // 再小棋子上的汉字就糊了:触底后由 .board-wrap 出滚动条
const BOARD_FILL = 0.94;  // 棋盘占可用区域的比例
const MARGIN = 0.62;      // 棋盘外框到 canvas 边缘的留白,单位 = cell

const GW = COLS - 1;
const GH = ROWS - 1;
const WU = GW + 2 * MARGIN;   // 9.24 个 cell 宽
const HU = GH + 2 * MARGIN;   // 10.24 个 cell 高

const TAU = Math.PI * 2;
const CANVAS_SERIF = '"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif';

/* 参与动画的颜色一律存 "r,g,b" 三元组,透明度由动画曲线给。 */
const PALETTES = {
  dark: {
    wood: ['#8f6038', '#754c2b', '#6a4325'],
    grain: 'rgba(58,34,16,0.16)',
    vignette: 'rgba(18,10,4,0.42)',
    grid: 'rgba(38,24,12,0.78)',
    border: 'rgba(28,16,6,0.92)',
    riverText: 'rgba(242,228,204,0.15)',
    shadow: 'rgba(0,0,0,0.42)',
    face: { hi: '#fffaef', mid: '#f2e6cf', lo: '#d5c4a6', rim: '#8a7150' },
    ink: { [RED]: '#b8371f', [BLACK]: '#2b2119' },
    sel: '216,164,74',
    target: '216,164,74',
    last: '242,228,204',
    check: '226,72,44',
    ghost: '242,228,204',
    ripple: '255,245,230',
    win: '216,164,74',
    wash: 'rgba(14,9,5,0.5)',
    composite: 'lighter',
  },
  light: {
    wood: ['#e6cfa8', '#d8bd92', '#cdae7f'],
    grain: 'rgba(150,110,62,0.14)',
    vignette: 'rgba(120,86,44,0.16)',
    grid: 'rgba(74,50,26,0.72)',
    border: 'rgba(58,38,18,0.86)',
    riverText: 'rgba(58,38,18,0.18)',
    shadow: 'rgba(90,60,30,0.3)',
    face: { hi: '#fffdf7', mid: '#f7efdf', lo: '#e0d2b8', rim: '#9c8461' },
    ink: { [RED]: '#a82f18', [BLACK]: '#241c14' },
    sel: '138,100,32',
    target: '138,100,32',
    last: '60,42,24',
    check: '190,44,26',
    ghost: '60,42,24',
    ripple: '120,86,44',
    win: '138,100,32',
    wash: 'rgba(240,230,212,0.5)',
    composite: 'source-over',
  },
};

function easeOutBack(t) {
  const c = 1.6;
  const p = t - 1;
  return 1 + (c + 1) * p * p * p + c * p * p;
}

function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

/** 确定性伪随机:木纹每次画出来一样,不然 resize 会闪。 */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Renderer {
  constructor(wrap, canvas, theme) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.theme = PALETTES[theme] ? theme : 'dark';
    this.pal = PALETTES[this.theme];
    this.cell = MIN_CELL;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.base = null;
    this.sprites = null;

    this.board = null;
    this.sel = null;
    this.targets = [];
    this.hover = null;
    this.last = null;
    this.checkCell = -1;

    this.anims = [];
    this.winFx = null;
    this.selT0 = 0;
    this.raf = 0;
    this.dirty = true;
  }

  setBoard(board) { this.board = board; this.mark(); }

  /* -------------------------------- geometry ------------------------------- */

  px(f) { return (MARGIN + f) * this.cell; }
  py(r) { return (MARGIN + r) * this.cell; }

  layout() {
    const rect = this.wrap.getBoundingClientRect();
    let cell = Math.min(
      (rect.width - 8) * BOARD_FILL / WU,
      (rect.height - 8) * BOARD_FILL / HU,
    );
    cell = Math.max(MIN_CELL, cell);
    this.cell = cell;
    this.w = WU * cell;
    this.h = HU * cell;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintBase();
    this.buildSprites();
    this.mark();
  }

  setTheme(name) {
    if (!PALETTES[name] || this.theme === name) return;
    this.theme = name;
    this.pal = PALETTES[name];
    // 只重画缓存层和精灵,不重新测量:主题切换不该改变尺寸。
    this.paintBase();
    this.buildSprites();
    this.mark();
  }

  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const f = Math.round(x / this.cell - MARGIN);
    const r = Math.round(y / this.cell - MARGIN);
    if (!onBoard(f, r)) return null;
    const dx = x - this.px(f);
    const dy = y - this.py(r);
    // 象棋棋子直径接近一格,吸附范围给到 0.72 格;超出棋盘外框则不算命中。
    const lim = this.cell * 0.72;
    if (dx * dx + dy * dy > lim * lim) return null;
    return { f, r };
  }

  /* --------------------------------- state --------------------------------- */

  setSelection(cell, moves) {
    this.sel = cell;
    this.targets = moves || [];
    this.selT0 = performance.now();
    this.mark();
  }

  setHover(cell) {
    if (!this.hover && !cell) return;
    this.hover = cell;
    this.mark();
  }

  setLastMove(from, to) {
    this.last = from && to ? { from, to } : null;
    this.mark();
  }

  setCheck(cell) {
    if (this.checkCell === cell) return;
    this.checkCell = cell;
    this.mark();
  }

  mark() {
    this.dirty = true;
    this.requestDraw();
  }

  /* --------------------------------- base ---------------------------------- */

  paintBase() {
    const cell = this.cell;
    const pal = this.pal;
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const grad = g.createLinearGradient(0, 0, this.w, this.h);
    grad.addColorStop(0, pal.wood[0]);
    grad.addColorStop(0.5, pal.wood[1]);
    grad.addColorStop(1, pal.wood[2]);
    g.fillStyle = grad;
    g.fillRect(0, 0, this.w, this.h);

    const rnd = mulberry(0x5eed);
    g.strokeStyle = pal.grain;
    g.lineWidth = Math.max(0.6, cell * 0.02);
    for (let i = 0; i < 130; i++) {
      const y = rnd() * this.h;
      const amp = cell * (0.05 + rnd() * 0.16);
      const freq = 0.004 + rnd() * 0.006;
      const phase = rnd() * TAU;
      g.beginPath();
      for (let x = 0; x <= this.w; x += cell * 0.5) {
        const yy = y + Math.sin(x * freq + phase) * amp;
        if (x === 0) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.globalAlpha = 0.35 + rnd() * 0.5;
      g.stroke();
    }
    g.globalAlpha = 1;

    const vg = g.createRadialGradient(this.w / 2, this.h / 2, cell * 2, this.w / 2, this.h / 2, this.h * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, pal.vignette);
    g.fillStyle = vg;
    g.fillRect(0, 0, this.w, this.h);

    const lw = Math.max(1, cell * 0.028);
    g.strokeStyle = pal.grid;
    g.lineWidth = lw;
    g.lineCap = 'square';

    // 横线全宽
    g.beginPath();
    for (let r = 0; r < ROWS; r++) {
      g.moveTo(this.px(0), this.py(r));
      g.lineTo(this.px(GW), this.py(r));
    }
    // 竖线:只有两边贯上下,中间在河界断开
    for (let f = 0; f < COLS; f++) {
      if (f === 0 || f === GW) {
        g.moveTo(this.px(f), this.py(0));
        g.lineTo(this.px(f), this.py(GH));
      } else {
        g.moveTo(this.px(f), this.py(0));
        g.lineTo(this.px(f), this.py(4));
        g.moveTo(this.px(f), this.py(5));
        g.lineTo(this.px(f), this.py(GH));
      }
    }
    // 九宫斜线
    for (const base of [0, GH - 2]) {
      g.moveTo(this.px(3), this.py(base));
      g.lineTo(this.px(5), this.py(base + 2));
      g.moveTo(this.px(5), this.py(base));
      g.lineTo(this.px(3), this.py(base + 2));
    }
    g.stroke();

    // 外框:双线
    g.strokeStyle = pal.border;
    g.lineWidth = lw * 1.7;
    const o = cell * 0.2;
    g.strokeRect(this.px(0) - o, this.py(0) - o, GW * cell + o * 2, GH * cell + o * 2);
    g.lineWidth = lw * 0.8;
    const o2 = cell * 0.34;
    g.strokeRect(this.px(0) - o2, this.py(0) - o2, GW * cell + o2 * 2, GH * cell + o2 * 2);

    // 炮位/兵位的小角标
    this.paintPositionMarks(g);

    // 河界
    if (cell >= 30) {
      g.fillStyle = pal.riverText;
      g.font = `600 ${Math.round(cell * 0.62)}px ${CANVAS_SERIF}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const ry = (this.py(4) + this.py(5)) / 2;
      g.fillText('楚 河', this.px(1.6), ry);
      g.save();
      g.translate(this.px(6.4), ry);
      g.rotate(Math.PI);
      g.fillText('漢 界', 0, 0);
      g.restore();
    }

    this.base = c;
  }

  /** 炮和兵的起始位画一个小 L 形角标,和实体棋盘的刻痕一致。 */
  paintPositionMarks(g) {
    const cell = this.cell;
    if (cell < 22) return;
    const len = cell * 0.16;
    const gap = cell * 0.05;
    g.strokeStyle = this.pal.grid;
    g.lineWidth = Math.max(1, cell * 0.03);
    g.lineCap = 'butt';
    const spots = [];
    for (const f of [1, 7]) spots.push([f, 2], [f, 7]);
    for (const f of [0, 2, 4, 6, 8]) spots.push([f, 3], [f, 6]);
    g.beginPath();
    for (const [f, r] of spots) {
      const x = this.px(f);
      const y = this.py(r);
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          // 边线上的点只画内侧两个角
          if (f === 0 && sx < 0) continue;
          if (f === GW && sx > 0) continue;
          const ax = x + sx * gap;
          const ay = y + sy * gap;
          g.moveTo(ax + sx * len, ay);
          g.lineTo(ax, ay);
          g.lineTo(ax, ay + sy * len);
        }
      }
    }
    g.stroke();
  }

  /* -------------------------------- sprites -------------------------------- */

  buildSprites() {
    const cell = this.cell;
    const pal = this.pal;
    const r = cell * 0.44;
    const pad = Math.max(3, cell * 0.18);
    const size = Math.ceil((r + pad) * 2);
    this.spriteSize = size;
    this.sprites = {};

    for (const side of [RED, BLACK]) {
      for (let t = T_KING; t <= T_PAWN; t++) {
        const v = makePiece(side, t);
        const c = document.createElement('canvas');
        c.width = Math.round(size * this.dpr);
        c.height = Math.round(size * this.dpr);
        const g = c.getContext('2d');
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        const cx = size / 2;
        const cy = size / 2;

        g.save();
        g.translate(0, cell * 0.055);
        g.fillStyle = pal.shadow;
        g.beginPath();
        g.arc(cx, cy, r, 0, TAU);
        g.fill();
        g.restore();

        const face = pal.face;
        const grad = g.createRadialGradient(cx - r * 0.34, cy - r * 0.4, r * 0.12, cx, cy, r);
        grad.addColorStop(0, face.hi);
        grad.addColorStop(0.55, face.mid);
        grad.addColorStop(1, face.lo);
        g.fillStyle = grad;
        g.beginPath();
        g.arc(cx, cy, r, 0, TAU);
        g.fill();

        const rimW = Math.max(1, cell * 0.03);
        g.strokeStyle = face.rim;
        g.lineWidth = rimW;
        g.beginPath();
        g.arc(cx, cy, r - rimW / 2, 0, TAU);
        g.stroke();

        const ink = pal.ink[side];
        const ringW = Math.max(1, cell * 0.038);
        g.strokeStyle = ink;
        g.lineWidth = ringW;
        g.beginPath();
        g.arc(cx, cy, r * 0.775, 0, TAU);
        g.stroke();

        g.fillStyle = ink;
        g.font = `600 ${Math.round(r * 1.02)}px ${CANVAS_SERIF}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(PIECE_CHARS[side][t], cx, cy + r * 0.05);

        this.sprites[v] = c;
      }
    }
  }

  drawPiece(v, x, y, scale, alpha) {
    const img = this.sprites && this.sprites[v];
    if (!img) return;
    const size = this.spriteSize * scale;
    if (alpha !== undefined && alpha < 1) this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    this.ctx.globalAlpha = 1;
  }

  /* ------------------------------- animation ------------------------------- */

  /**
   * 走一步:棋子从起点滑到终点(象棋子瞬移看着像 bug),到位时弹入;
   * 有吃子就先让被吃的子缩小淡出,落子动画晚 60ms 起步,形成"先撞飞再落下"。
   * captured = { f, r, v } 或 null。
   */
  startMove(from, to, v, captured) {
    const now = performance.now();
    const delay = captured ? 60 : 0;
    this.anims.push({ kind: 'slide', from, to, v, t0: now, dur: 170 });
    if (captured) {
      this.anims.push({ kind: 'captured', cell: { f: captured.f, r: captured.r }, v: captured.v, t0: now, dur: 220 });
    }
    this.anims.push({ kind: 'place', cell: to, t0: now + delay, dur: 260 });
    this.anims.push({ kind: 'ripple', cell: to, t0: now + delay, dur: 480 });
    this.mark();
  }

  startWin(cell, won) {
    this.winFx = { cell, won, t0: performance.now(), life: 4000 };
    this.mark();
  }

  clearWin() {
    this.winFx = null;
    this.mark();
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((t) => {
      this.raf = 0;
      this.frame(t);
    });
  }

  frame(now) {
    const live = [];
    for (const a of this.anims) {
      if (now < a.t0) live.push(a);
      else if (now - a.t0 < a.dur) live.push(a);
    }
    this.anims = live;
    this.paint(now);
    this.dirty = false;
    // 选中提示是 140/160ms 的淡入,不在 anims 里。不为此续帧的话,唯一那一帧
    // 正好停在淡入起点(落点还是透明的),要等鼠标一动才画得出来。
    const selFading = this.sel && now - this.selT0 < 170;
    if (this.anims.length || this.winFx || this.checkCell >= 0 || selFading) this.requestDraw();
  }

  animOf(kind) {
    for (const a of this.anims) if (a.kind === kind) return a;
    return null;
  }

  /* --------------------------------- paint --------------------------------- */

  paint(now) {
    const ctx = this.ctx;
    if (!this.base) return;

    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.base, 0, 0, this.w, this.h);

    const slide = this.animOf('slide');
    const captured = this.animOf('captured');
    const place = this.animOf('place');

    this.paintLastMove(ctx);
    if (this.board) this.paintPieces(ctx, now, slide, place, captured);
    this.paintTargets(ctx, now);
    this.paintSelection(ctx, now);
    this.paintGhost(ctx);
    this.paintCaptured(ctx, now, captured);
    this.paintCheck(ctx, now);
    if (this.winFx) this.paintWin(ctx, now);
  }

  paintLastMove(ctx) {
    if (!this.last) return;
    const cell = this.cell;
    const pal = this.pal;
    ctx.save();
    ctx.strokeStyle = `rgba(${pal.last},0.5)`;
    ctx.lineWidth = Math.max(1, cell * 0.045);
    ctx.beginPath();
    ctx.arc(this.px(this.last.to.f), this.py(this.last.to.r), cell * 0.5, 0, TAU);
    ctx.stroke();
    // 起点画个小实心点:象棋要看"从哪来",光有终点圈找不到。
    ctx.fillStyle = `rgba(${pal.last},0.42)`;
    ctx.beginPath();
    ctx.arc(this.px(this.last.from.f), this.py(this.last.from.r), cell * 0.11, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  paintPieces(ctx, now, slide, place, captured) {
    const g = this.board.grid;
    const cell = this.cell;
    const pal = this.pal;
    const skip = slide ? sq(slide.to.f, slide.to.r) : -1;
    const capSkip = captured ? sq(captured.cell.f, captured.cell.r) : -1;

    let placeScale = 1;
    let placeCell = -1;
    if (place && now >= place.t0) {
      const t = clamp01((now - place.t0) / place.dur);
      placeScale = 1 + 0.35 * (1 - easeOutBack(t));
      placeCell = sq(place.cell.f, place.cell.r);
    }

    for (let i = 0; i < CELLS; i++) {
      const v = g[i];
      if (v === EMPTY) continue;
      if (i === skip || i === capSkip) continue;
      this.drawPiece(v, this.px(fileOf(i)), this.py(rankOf(i)), i === placeCell ? placeScale : 1);
    }

    if (slide) {
      const t = clamp01((now - slide.t0) / slide.dur);
      if (t >= 1) {
        this.drawPiece(slide.v, this.px(slide.to.f), this.py(slide.to.r), placeScale);
      } else {
        const e = easeOutQuad(t);
        this.drawPiece(
          slide.v,
          this.px(slide.from.f) + (this.px(slide.to.f) - this.px(slide.from.f)) * e,
          this.py(slide.from.r) + (this.py(slide.to.r) - this.py(slide.from.r)) * e,
          1,
        );
      }
    }

    const ripple = this.animOf('ripple');
    if (ripple && now >= ripple.t0) {
      const t = clamp01((now - ripple.t0) / ripple.dur);
      ctx.save();
      ctx.strokeStyle = `rgba(${pal.ripple},${(1 - t) * 0.55})`;
      ctx.lineWidth = Math.max(1, cell * 0.05 * (1 - t) + 0.6);
      ctx.beginPath();
      ctx.arc(this.px(ripple.cell.f), this.py(ripple.cell.r), cell * (0.34 + t * 0.42), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  paintCaptured(ctx, now, captured) {
    if (!captured) return;
    const t = clamp01((now - captured.t0) / captured.dur);
    const x = this.px(captured.cell.f);
    const y = this.py(captured.cell.r);
    this.drawPiece(captured.v, x, y, 1 - 0.75 * t, 1 - t);
    const cell = this.cell;
    ctx.save();
    ctx.strokeStyle = `rgba(${this.pal.check},${(1 - t) * 0.7})`;
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.beginPath();
    ctx.arc(x, y, cell * (0.4 + t * 0.3), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** 空落点画实心点,可吃的子画四角括号 —— 一眼能分清"去"还是"吃"。 */
  paintTargets(ctx, now) {
    if (!this.sel || !this.targets.length) return;
    const cell = this.cell;
    const pal = this.pal;
    const fade = clamp01((now - this.selT0) / 140);
    ctx.save();
    for (const m of this.targets) {
      const x = this.px(m.tf);
      const y = this.py(m.tr);
      const isCap = this.board.at(m.tf, m.tr) !== EMPTY;
      if (isCap) {
        const s = cell * 0.46;
        const a = cell * 0.16;
        ctx.strokeStyle = `rgba(${pal.target},${0.85 * fade})`;
        ctx.lineWidth = Math.max(1.2, cell * 0.05);
        ctx.beginPath();
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            ctx.moveTo(x + sx * s, y + sy * (s - a));
            ctx.lineTo(x + sx * s, y + sy * s);
            ctx.lineTo(x + sx * (s - a), y + sy * s);
          }
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${pal.target},${0.5 * fade})`;
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.13 * (0.6 + 0.4 * fade), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  paintSelection(ctx, now) {
    if (!this.sel) return;
    const cell = this.cell;
    const pal = this.pal;
    const x = this.px(this.sel.f);
    const y = this.py(this.sel.r);
    const t = clamp01((now - this.selT0) / 160);
    ctx.save();
    ctx.strokeStyle = `rgba(${pal.sel},${0.55 + 0.35 * t})`;
    ctx.lineWidth = Math.max(1.4, cell * 0.06);
    ctx.beginPath();
    ctx.arc(x, y, cell * (0.5 + 0.06 * (1 - t)), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  paintGhost(ctx) {
    if (!this.hover || !this.board || this.sel) return;
    const v = this.board.at(this.hover.f, this.hover.r);
    if (v === EMPTY) return;
    if (sideOf(v) !== this.board.current) return;
    const cell = this.cell;
    ctx.save();
    ctx.strokeStyle = `rgba(${this.pal.ghost},0.4)`;
    ctx.lineWidth = Math.max(1, cell * 0.035);
    ctx.beginPath();
    ctx.arc(this.px(this.hover.f), this.py(this.hover.r), cell * 0.48, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  paintCheck(ctx, now) {
    if (this.checkCell < 0) return;
    const cell = this.cell;
    const f = fileOf(this.checkCell);
    const r = rankOf(this.checkCell);
    const pulse = 0.5 + 0.5 * Math.sin(now / 1000 * 6);
    ctx.save();
    ctx.strokeStyle = `rgba(${this.pal.check},${0.35 + 0.45 * pulse})`;
    ctx.lineWidth = Math.max(1.4, cell * 0.06);
    ctx.beginPath();
    ctx.arc(this.px(f), this.py(r), cell * (0.52 + 0.06 * pulse), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  paintWin(ctx, now) {
    const fx = this.winFx;
    const age = now - fx.t0;
    if (age > fx.life) {
      this.winFx = null;
      return;
    }
    const cell = this.cell;
    const pal = this.pal;
    const t = age / fx.life;
    const x = this.px(fx.cell.f);
    const y = this.py(fx.cell.r);

    ctx.save();
    ctx.fillStyle = pal.wash;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.globalCompositeOperation = pal.composite;

    // 光柱
    const beam = 1 - t;
    ctx.save();
    ctx.shadowColor = `rgba(${pal.win},${0.7 * beam})`;
    ctx.shadowBlur = cell * 0.7;
    const g = ctx.createLinearGradient(x, y - cell * 2, x, y + cell * 2);
    g.addColorStop(0, `rgba(${pal.win},0)`);
    g.addColorStop(0.5, `rgba(${pal.win},${0.5 * beam})`);
    g.addColorStop(1, `rgba(${pal.win},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - cell * 0.5, y - cell * 2, cell, cell * 4);
    ctx.restore();

    // 脉冲环
    ctx.strokeStyle = `rgba(${pal.win},${0.6 * beam})`;
    ctx.lineWidth = Math.max(1.4, cell * 0.06);
    for (let i = 0; i < 3; i++) {
      const p = ((t * 3 + i * 0.33) % 1);
      ctx.globalAlpha = 1 - p;
      ctx.beginPath();
      ctx.arc(x, y, cell * (0.4 + p * 1.1), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 飞散的火星
    const rnd = mulberry(0xc0ffee);
    for (let i = 0; i < 9; i++) {
      const ang = rnd() * TAU;
      const spd = cell * (0.9 + rnd() * 1.5);
      const vx = Math.cos(ang) * spd;
      const vy = Math.sin(ang) * spd - cell * 1.2;
      const px = x + vx * t;
      const py = y + vy * t + 2.2 * cell * t * t;
      ctx.fillStyle = `hsla(${30 + rnd() * 20},85%,${55 + rnd() * 20}%,${1 - t})`;
      ctx.beginPath();
      ctx.arc(px, py, cell * 0.05 * (1 - t * 0.5), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
}
