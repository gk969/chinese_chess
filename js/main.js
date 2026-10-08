/**
 * 界面调度:回合流转、点选落子、悔棋、棋谱、状态栏。
 *
 * 棋的规则全在 rules.js 的 Board 里,这里只决定"什么时候让谁走、走完显示什么"。
 * 电脑搜索直接在这同一个 board 上做 make/unmake,所以搜索期间不能碰它 ——
 * 一片结束时会退回根局面,两片之间读它是安全的。
 */

const PREFS_KEY = 'xiangqi.prefs';

const DIFF_HINT = {
  low: '随手棋,会明显送子',
  mid: '会算几步,偶尔漏着',
  high: '算得深,下得认真',
};

const $ = (id) => document.getElementById(id);
const fmtNum = (n) => n.toLocaleString('en-US');

class Game {
  constructor() {
    this.prefs = this.readPrefs();
    this.board = new Board();
    this.sound = new Sound();

    this.el = {
      turnChip: $('turnChip'),
      turnText: $('turnText'),
      statusMsg: $('statusMsg'),
      statusStat: $('statusStat'),
      difficulty: $('difficulty'),
      difficultyHint: $('difficultyHint'),
      side: $('side'),
      moves: $('moves'),
      undo: $('undo'),
      restart: $('restart'),
      mute: $('mute'),
      volume: $('volume'),
      themeBtn: $('themeBtn'),
      banner: $('banner'),
      stamp: $('stamp'),
      bannerText: $('bannerText'),
      bannerAgain: $('bannerAgain'),
    };

    this.renderer = new Renderer(
      $('boardWrap'),
      $('board'),
      document.documentElement.getAttribute('data-theme') || 'dark',
    );
    this.renderer.setBoard(this.board);

    this.human = this.prefs.side;
    this.level = this.prefs.level;
    this.over = false;
    this.sel = null;
    this.selMoves = [];
    // 悔棋/重开/换难度都让已经在跑的搜索结果作废:回调时令牌不符就丢掉。
    this.token = 0;
    this.statTimer = 0;
    this.reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.bindUI();
    this.applyPrefs();

    // 先量一次拿到非零尺寸,ResizeObserver 只负责之后的变化。
    this.renderer.layout();
    this.observeResize();
    this.newGame();

    window.xiangqi = this; // 控制台自测入口
  }

  /* --------------------------------- prefs --------------------------------- */

  readPrefs() {
    let p = {};
    try {
      p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    } catch (e) {
      p = {}; // file:// 下部分浏览器禁 localStorage:偏好就只在本次会话有效
    }
    const vol = Number(p.volume);
    return {
      theme: p.theme === 'light' ? 'light' : 'dark',
      level: PROFILES[p.level] ? p.level : 'mid',
      side: p.side === BLACK ? BLACK : RED,
      muted: p.muted === true,
      volume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 0.7,
    };
  }

  savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch (e) { /* 同上 */ }
  }

  applyPrefs() {
    const theme = this.prefs.theme;
    document.documentElement.setAttribute('data-theme', theme);
    this.renderer.setTheme(theme);

    for (const b of this.el.difficulty.querySelectorAll('button[data-v]')) {
      b.setAttribute('aria-checked', String(b.dataset.v === this.prefs.level));
    }
    for (const b of this.el.side.querySelectorAll('button[data-v]')) {
      b.setAttribute('aria-checked', String(Number(b.dataset.v) === this.prefs.side));
    }
    this.el.mute.setAttribute('aria-checked', String(!this.prefs.muted));
    this.el.volume.value = String(Math.round(this.prefs.volume * 100));
    this.sound.setEnabled(!this.prefs.muted);
    this.sound.setVolume(this.prefs.volume);
    this.el.difficultyHint.textContent = DIFF_HINT[this.level];
  }

  /* ---------------------------------- ui ----------------------------------- */

  bindUI() {
    // AudioContext 要等第一次真实手势才建得起来。
    const unlock = () => this.sound.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });

    this.bindSeg(this.el.difficulty, (v) => this.setLevel(v));
    this.bindSeg(this.el.side, (v) => {
      this.human = Number(v);
      this.prefs.side = this.human;
      this.savePrefs();
      this.newGame();
    });

    this.el.themeBtn.addEventListener('click', () => {
      const next = this.prefs.theme === 'dark' ? 'light' : 'dark';
      this.prefs.theme = next;
      this.savePrefs();
      document.documentElement.setAttribute('data-theme', next);
      this.renderer.setTheme(next);
    });

    this.el.undo.addEventListener('click', () => this.undo());
    this.el.restart.addEventListener('click', () => this.newGame());
    this.el.bannerAgain.addEventListener('click', () => this.newGame());

    this.el.mute.addEventListener('click', () => {
      this.prefs.muted = !this.prefs.muted;
      this.savePrefs();
      this.el.mute.setAttribute('aria-checked', String(!this.prefs.muted));
      this.sound.setEnabled(!this.prefs.muted);
    });

    this.el.volume.addEventListener('input', () => {
      this.prefs.volume = Number(this.el.volume.value) / 100;
      this.savePrefs();
      this.sound.setVolume(this.prefs.volume);
    });

    const canvas = this.renderer.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      // 触屏不给 hover 幽灵子:手指离开后那个环会留在原地。
      if (e.pointerType !== 'mouse') this.renderer.setHover(null);
      const cell = this.renderer.hitTest(e.clientX, e.clientY);
      if (!cell) {
        this.clearSel();
        return;
      }
      this.tap(cell);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.renderer.setHover(this.locked ? null : this.renderer.hitTest(e.clientX, e.clientY));
    });
    canvas.addEventListener('pointerleave', () => this.renderer.setHover(null));
  }

  /** 分段控件:点选 + 方向键,role=radio 要这两样才算完整。 */
  bindSeg(el, onPick) {
    const pick = (btn) => {
      if (btn.getAttribute('aria-checked') === 'true') return;
      for (const b of el.querySelectorAll('button[data-v]')) b.setAttribute('aria-checked', String(b === btn));
      onPick(btn.dataset.v);
    };
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (btn) pick(btn);
    });
    el.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const all = Array.from(el.querySelectorAll('button[data-v]'));
      const at = all.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const next = all[Math.min(all.length - 1, Math.max(0, at + step))];
      next.focus();
      pick(next);
    });
  }

  observeResize() {
    let pending = 0;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        this.renderer.layout();
      });
    });
    ro.observe(this.renderer.wrap);
  }

  setLevel(v) {
    if (!PROFILES[v]) return;
    this.level = v;
    this.prefs.level = v;
    this.savePrefs();
    this.el.difficultyHint.textContent = DIFF_HINT[v];
    // 正在想的时候换难度:丢掉这一局,按新档位重新想。
    if (AI.busy && !this.over) {
      this.token++;
      AI.stop();
      this.thinking(false);
      if (this.board.current !== this.human) this.scheduleAI();
    }
  }

  /* ------------------------------- new / undo ------------------------------ */

  newGame() {
    this.token++;
    AI.stop();
    this.stopStatTimer();
    this.board.reset();
    this.over = false;
    this.sel = null;
    this.selMoves = [];

    this.renderer.clearWin();
    this.renderer.setLastMove(null, null);
    this.renderer.setCheck(-1);
    this.thinking(false);
    this.renderer.setSelection(null, []);
    this.renderer.setBoard(this.board);

    this.el.banner.hidden = true;
    this.el.moves.textContent = '';
    this.el.statusStat.textContent = '';
    this.updateUndo();
    this.syncTurn();
    this.say(this.human === RED ? '轮到你走' : '电脑先走', '');

    if (this.board.current !== this.human) this.scheduleAI();
  }

  undo() {
    if (!this.board.history.length) return;
    this.token++;
    AI.stop();
    this.stopStatTimer();
    this.thinking(false);
    this.clearSel();
    this.over = false;
    this.el.banner.hidden = true;
    this.renderer.clearWin();

    // 一直撤到又轮到人类 —— 正常是两步(电脑一步 + 人类一步)。
    do {
      this.board.undo();
    } while (this.board.history.length && this.board.current !== this.human);

    const h = this.board.history;
    const last = h[h.length - 1];
    this.renderer.setLastMove(
      last ? { f: last.m.f, r: last.m.r } : null,
      last ? { f: last.m.tf, r: last.m.tr } : null,
    );
    this.syncCheck();
    this.renderMoves();
    this.updateUndo();
    this.syncTurn();
    this.sound.undo();
    this.say('已悔棋', '');

    // 只撤了一步就把人类的开局撤没了(执黑时电脑先走过一手):让电脑重新想。
    if (this.board.current !== this.human) this.scheduleAI();
  }

  /* --------------------------------- turns --------------------------------- */

  get locked() {
    return this.over || AI.busy;
  }

  tap(cell) {
    if (this.locked) return;
    const b = this.board;
    const v = b.at(cell.f, cell.r);

    if (this.sel) {
      const m = this.selMoves.find((x) => x.tf === cell.f && x.tr === cell.r);
      if (m) {
        this.play(m);
        return;
      }
      if (v !== EMPTY && sideOf(v) === b.current) {
        this.select(cell); // 换选,不弹错误
        return;
      }
      this.clearSel();
      this.sound.reject();
      this.say('那里走不过去', 'bad');
      return;
    }

    if (v !== EMPTY && sideOf(v) === b.current) this.select(cell);
  }

  select(cell) {
    const moves = this.board.legalMoves(this.board.current).filter((m) => m.f === cell.f && m.r === cell.r);
    if (!moves.length) {
      this.sound.reject();
      this.say('这个子现在动不了', 'bad');
      return;
    }
    this.sel = cell;
    this.selMoves = moves;
    this.renderer.setSelection(cell, moves);
    this.sound.select();
  }

  clearSel() {
    if (!this.sel) return;
    this.sel = null;
    this.selMoves = [];
    this.renderer.setSelection(null, []);
  }

  play(m) {
    const b = this.board;
    const from = { f: m.f, r: m.r };
    const to = { f: m.tf, r: m.tr };
    const v = b.at(m.f, m.r);
    const side = sideOf(v);

    const text = notate(b, m); // 记谱看的是走之前的盘面,必须在 make 之前算
    m.text = text;
    const cap = b.make(m);

    this.clearSel();
    this.renderer.setLastMove(from, to);
    if (!this.reduceMotion) {
      this.renderer.startMove(from, to, v, cap === EMPTY ? null : { f: m.tf, r: m.tr, v: cap });
    }
    this.renderer.mark();
    if (cap === EMPTY) this.sound.move(side);
    else this.sound.capture(side);

    this.renderMoves();
    this.afterMove();
  }

  afterMove() {
    const st = this.board.gameState();
    this.syncTurn();
    if (st.over) {
      this.finish(st);
      return;
    }

    this.syncCheck();
    const checked = this.board.inCheck(this.board.current);
    if (checked) this.sound.check();
    this.updateUndo();

    if (this.board.current !== this.human) this.scheduleAI();
    else this.say(checked ? '将军 —— 轮到你走' : '轮到你走', checked ? 'check' : '');
  }

  scheduleAI() {
    const token = ++this.token;
    this.thinking(true);
    this.renderer.setHover(null);
    this.updateUndo();
    this.say('对方思考中…', 'thinking');
    this.startStatTimer();

    AI.think(this.board, this.level, (res) => {
      if (token !== this.token) return; // 悔棋/重开/换难度之后的陈旧结果
      this.stopStatTimer();
      this.thinking(false);
      if (!res.move) {
        this.afterMove();
        return;
      }
      this.statLine(`电脑 · ${res.depth} 层 · ${fmtNum(res.nodes)} 个局面 · ${(res.elapsed / 1000).toFixed(2)} 秒`);
      this.play(res.move);
    });
  }

  finish(st) {
    this.over = true;
    this.token++;
    AI.stop();
    this.stopStatTimer();
    this.thinking(false);
    this.renderer.setCheck(-1);
    this.clearSel();
    this.updateUndo();

    const iWon = st.winner === this.human;
    let stamp;
    let text;
    let cls = '';
    if (st.winner === null) {
      stamp = '和';
      cls = ' draw';
      text = '同一局面重复三次,判和';
      this.sound.draw();
    } else if (iWon) {
      stamp = '胜';
      text = st.reason === 'mate' ? '将死对方' : '对方无子可走';
      this.sound.win();
    } else {
      stamp = '负';
      cls = ' lose';
      text = st.reason === 'mate' ? '被将死' : '无子可走';
      this.sound.lose();
    }

    this.el.stamp.textContent = stamp;
    this.el.stamp.className = 'stamp' + cls;
    this.el.bannerText.textContent = text;
    this.el.banner.hidden = false;

    if (st.lostKing >= 0 && !this.reduceMotion) {
      this.renderer.startWin({ f: fileOf(st.lostKing), r: rankOf(st.lostKing) }, iWon);
    }
    this.statLine(st.reason === 'repetition' ? '重复局面三次' : st.reason === 'mate' ? '将死' : '困毙');
    this.say(st.winner === null ? '和棋' : iWon ? '你赢了' : '你输了', iWon ? '' : 'bad');
  }

  /* -------------------------------- display -------------------------------- */

  /** 思考状态还要落到 canvas 的类上,光标才会变成 progress。 */
  thinking(on) {
    this.renderer.setThinking(on);
    this.renderer.canvas.classList.toggle('thinking', on);
  }

  syncCheck() {
    const b = this.board;
    this.renderer.setCheck(b.inCheck(b.current) ? b.kings[b.current] : -1);
  }

  syncTurn() {
    const red = this.board.current === RED;
    this.el.turnChip.textContent = red ? '帥' : '將';
    this.el.turnChip.className = 'chip ' + (red ? 'red' : 'black');
    this.el.turnText.textContent = this.over
      ? '本局结束'
      : this.board.current === this.human
        ? '轮到你走'
        : '轮到电脑';
  }

  say(msg, cls) {
    this.el.statusMsg.textContent = msg;
    this.el.statusMsg.className = 'status-msg' + (cls ? ' ' + cls : '');
  }

  statLine(text) {
    this.el.statusStat.textContent = text;
  }

  /** 思考时实时报数。用 setTimeout 链而不是 rAF —— 后台标签页里 rAF 会被冻住。 */
  startStatTimer() {
    this.stopStatTimer();
    const tick = () => {
      const s = AI.current;
      if (!s) return;
      this.statLine(`电脑 · ${s.completeDepth} 层 · ${fmtNum(s.nodes)} 个局面`);
      this.statTimer = setTimeout(tick, 120);
    };
    this.statTimer = setTimeout(tick, 120);
  }

  stopStatTimer() {
    if (!this.statTimer) return;
    clearTimeout(this.statTimer);
    this.statTimer = 0;
  }

  updateUndo() {
    this.el.undo.disabled = !this.board.history.length || AI.busy;
  }

  /** 棋谱每次整体重建:悔棋要缩短它,重建成本来就不长,比做增量对账省事。 */
  renderMoves() {
    const h = this.board.history;
    const frag = document.createDocumentFragment();
    let last = null;
    for (let i = 0; i < h.length; i++) {
      if (i % 2 === 0) {
        const no = document.createElement('span');
        no.className = 'no';
        no.textContent = String((i >> 1) + 1);
        frag.appendChild(no);
      }
      const cell = document.createElement('span');
      cell.className = 'mv' + (sideOf(h[i].v) === RED ? ' red' : '');
      cell.textContent = h[i].text || '·';
      frag.appendChild(cell);
      last = cell;
    }
    this.el.moves.textContent = '';
    this.el.moves.appendChild(frag);
    if (!last) return;
    last.classList.add('now');
    if (!this.reduceMotion) last.classList.add('flash');
    this.el.moves.scrollTop = this.el.moves.scrollHeight;
  }
}

window.addEventListener('DOMContentLoaded', () => new Game());
