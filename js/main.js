/**
 * 界面调度:回合流转、点选落子、悔棋、棋谱、状态栏。
 *
 * 棋的规则全在 rules.js 的 Board 里,这里只决定"什么时候让谁走、走完显示什么"。
 * 电脑搜索在它拿到的那个 board 上做 make/unmake,所以换视图(点走棋记录、切分支)
 * 一律换掉 this.board 而不是就地改它 —— 在跑的搜索手里那份局面不会被抽走。
 */

const PREFS_KEY = 'xiangqi.prefs';

/* 棋力两个旋钮直接暴露给用户:Skill Level 1~20(20 = 不加噪声),和每手时限。
   时限给的是引擎的 go movetime,引擎自己的开销算在里面。 */
const THINK_MS = [50, 100, 200, 500, 1000, 2000, 5000];
const POWER_DEFAULT = { skill: 2, ms: 50 };

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
      statA: $('statA'),
      statB: $('statB'),
      skill: $('skill'),
      think: $('think'),
      side: $('side'),
      moves: $('moves'),
      branch: $('branch'),
      branchRow: $('branchRow'),
      importBtn: $('importBtn'),
      exportBtn: $('exportBtn'),
      copyBtn: $('copyBtn'),
      pasteBtn: $('pasteBtn'),
      fileInput: $('fileInput'),
      pasteBox: $('pasteBox'),
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
    this.power = { skill: this.prefs.skill, ms: this.prefs.ms };
    this.over = false;
    this.sel = null;
    this.selMoves = [];
    /* 走棋记录是一棵树:主分支 + 从旧记录中间另起炉灶分出来的分支。moves 存 Board.history
       里那些条目对象(带 m、v、text),this.board 永远是"选中分支前 at 手之后"那个局面,
       由 replay 重放出来 —— 所以视图能往回跳,而在跑的搜索手里那份局面不受影响。 */
    this.branches = [{ moves: [] }];
    this.bi = 0;
    this.at = 0;
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
    const skill = Number(p.skill);
    const ms = Number(p.ms);
    return {
      theme: p.theme === 'light' ? 'light' : 'dark',
      skill: Number.isInteger(skill) && skill >= 1 && skill <= 20 ? skill : POWER_DEFAULT.skill,
      ms: THINK_MS.includes(ms) ? ms : POWER_DEFAULT.ms,
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

    for (const b of this.el.side.querySelectorAll('button[data-v]')) {
      b.setAttribute('aria-checked', String(Number(b.dataset.v) === this.prefs.side));
    }
    this.el.skill.value = String(this.prefs.skill);
    this.el.think.value = String(this.prefs.ms);
    this.el.mute.setAttribute('aria-checked', String(!this.prefs.muted));
    this.el.volume.value = String(Math.round(this.prefs.volume * 100));
    this.sound.setEnabled(!this.prefs.muted);
    this.sound.setVolume(this.prefs.volume);
  }

  /* ---------------------------------- ui ----------------------------------- */

  bindUI() {
    // AudioContext 要等第一次真实手势才建得起来。
    const unlock = () => this.sound.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, once: true });
    window.addEventListener('keydown', unlock, { capture: true, once: true });

    for (let s = 1; s <= 20; s++) this.el.skill.add(new Option('S' + s, s));
    for (const ms of THINK_MS) this.el.think.add(new Option(`${ms / 1000} 秒`, ms));
    const pickPower = () => this.setPower(Number(this.el.skill.value), Number(this.el.think.value));
    this.el.skill.addEventListener('change', pickPower);
    this.el.think.addEventListener('change', pickPower);

    this.el.branch.addEventListener('change', () => {
      const i = Number(this.el.branch.value);
      this.setView(i, this.branches[i].moves.length);
      this.say(`已切到${this.branchLabel(i)}`, '');
    });

    // 点记录不走 this.locked:复盘下完的棋是主要用法,思考中点记录本来就该打断。
    this.el.moves.addEventListener('click', (e) => {
      const cell = e.target.closest('button.mv');
      if (cell) this.viewMove(+cell.dataset.i);
    });

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

    this.el.exportBtn.addEventListener('click', () => this.exportMoves());
    this.el.copyBtn.addEventListener('click', () => this.copyMoves());
    this.el.pasteBtn.addEventListener('click', () => this.pasteMoves());
    this.el.importBtn.addEventListener('click', () => this.el.fileInput.click());
    this.el.fileInput.addEventListener('change', () => {
      const f = this.el.fileInput.files[0];
      this.el.fileInput.value = ''; // 同一个文件选两次也要能再导入
      if (f) this.readFile(f);
    });

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

  setPower(skill, ms) {
    this.prefs.skill = skill;
    this.prefs.ms = ms;
    this.power = { skill, ms };
    this.savePrefs();
    // 正在想的时候改棋力:丢掉这一局,按新参数重新想。
    if (AI.busy && !this.over) {
      this.token++;
      AI.stop();
      this.thinking(false);
      if (this.board.current !== this.human) this.scheduleAI();
    }
  }

  /* ------------------------------ 分支与视图 ------------------------------ */

  /** 分支的前 at 手重放成一个新局面。make 不查合法性也不改 move 对象,所以直接喂存下来的条目。 */
  replay(entries, at) {
    const b = new Board();
    for (let i = 0; i < at; i++) b.make(entries[i].m);
    return b;
  }

  /** 分支前 n 手之后轮到谁:上一手是谁走的,反过来就是;第 0 手是红方。 */
  sideToMove(entries, n) {
    return n ? other(entries[n - 1].side) : RED;
  }

  branchLabel(i) {
    return i === 0 ? '主分支' : '分支' + i;
  }

  /** 分支下拉:只有一条分支时整行藏掉。 */
  renderBranchSelect() {
    const sel = this.el.branch;
    sel.textContent = '';
    for (let i = 0; i < this.branches.length; i++) sel.add(new Option(this.branchLabel(i), i));
    sel.value = String(this.bi);
    this.el.branchRow.hidden = this.branches.length < 2;
  }

  /** 换视图的总入口:选中哪条分支、停在它前 at 手之后。 */
  setView(bi, at) {
    this.token++;
    AI.stop();
    this.stopStatTimer();
    this.thinking(false);
    this.clearSel();

    this.bi = bi;
    this.at = at;
    const mv = this.branches[bi].moves;
    this.board = this.replay(mv, at);

    const r = this.renderer;
    r.setBoard(this.board);
    r.resetFx();
    r.setSelection(null, []);
    r.setHover(null);
    r.setCheck(-1);
    const last = at ? mv[at - 1] : null;
    r.setLastMove(
      last ? { f: last.m.f, r: last.m.r } : null,
      last ? { f: last.m.tf, r: last.m.tr } : null,
    );

    const st = this.board.gameState();
    this.over = st.over;
    if (st.over) this.showOutcome(st, false);
    else {
      this.el.banner.hidden = true;
      this.el.stamp.className = 'stamp';
      this.statLines('', '');
      this.syncCheck();
    }

    this.renderBranchSelect();
    this.renderMoves();
    this.updateUndo();
    this.syncTurn();

    // 分支末尾正好轮到电脑是可达的(分支停在人类最后一手而该轮没有电脑那一手),
    // 这时必须补上这一手,否则上面的 token++ 已经把旧搜索废掉,局面就死在那儿。
    if (!this.over && this.board.current !== this.human) this.scheduleAI();
  }

  /** 点记录里任意一手 → 该轮电脑那一手之后的局面,所以视图永远轮到人类。 */
  viewMove(i) {
    const mv = this.branches[this.bi].moves;
    const aiPly = this.human === RED ? (i >> 1) * 2 + 1 : (i >> 1) * 2;
    const at = Math.min(aiPly + 1, mv.length);
    if (at === this.at) return;
    this.setView(this.bi, at);
    this.say(at === mv.length ? '走到最新' : `已回到第 ${(i >> 1) + 1} 轮`, '');
  }

  /** 在旧记录中间落子 = 分一条新线:前缀照旧,后面重新长。点最后一手再落子不新建。 */
  forkIfNeeded() {
    const mv = this.branches[this.bi].moves;
    if (this.at >= mv.length) return;
    this.branches.push({ moves: mv.slice(0, this.at) });
    this.bi = this.branches.length - 1;
    this.at = this.branches[this.bi].moves.length;
    this.renderBranchSelect();
  }

  /* ------------------------------- new / undo ------------------------------ */

  newGame() {
    this.branches = [{ moves: [] }];
    this.bi = 0;
    this.at = 0;
    this.say(this.human === RED ? '轮到你走' : '电脑先走', '');
    this.setView(0, 0);
  }

  undo() {
    const mv = this.branches[this.bi].moves;
    if (!mv.length) return;
    // 撤的是当前分支的最后一轮,和视图停在哪儿无关:从数组尾巴弹,弹到又轮到人类。
    do {
      mv.pop();
    } while (mv.length && this.sideToMove(mv, mv.length) !== this.human);

    this.sound.undo();
    this.say('已悔棋', '');
    this.setView(this.bi, mv.length);
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
    this.forkIfNeeded(); // 视图停在记录中间 → 先分一条新线,这一手就是新线的第一手
    const b = this.board;
    const from = { f: m.f, r: m.r };
    const to = { f: m.tf, r: m.tr };
    const v = b.at(m.f, m.r);
    const side = sideOf(v);

    const text = notate(b, m); // 记谱看的是走之前的盘面,必须在 make 之前算
    m.text = text;
    const cap = b.make(m);
    const mv = this.branches[this.bi].moves;
    mv.push(b.history[b.history.length - 1]);
    this.at = mv.length;

    this.clearSel();
    this.renderer.setLastMove(from, to);
    if (!this.reduceMotion) {
      this.renderer.startMove(from, to, v, cap === EMPTY ? null : { f: m.tf, r: m.tr, v: cap });
    }
    this.renderer.mark();
    if (cap === EMPTY) this.sound.move(side);
    else this.sound.capture(side);

    this.renderMoves(true);
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

    AI.think(this.board, this.power, (res) => {
      if (token !== this.token) return; // 悔棋/重开/改棋力之后的陈旧结果
      this.stopStatTimer();
      this.thinking(false);
      if (res.error) {
        this.say('引擎异常:' + res.error);
        this.statLines('', '');
        return;
      }
      if (!res.move) {
        this.afterMove();
        return;
      }
      this.statLines(
        `电脑 · ${res.depth} 层 · ${(res.elapsed / 1000).toFixed(2)} 秒`,
        `${fmtNum(res.nodes)} 个局面`,
      );
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
    this.showOutcome(st, true);
  }

  /** 结算显示。live = 这一手刚下完,才配音效和胜负动画;
      导航回一个已经走完的局面(点记录、切分支、导入)只把横幅和读数补上。 */
  showOutcome(st, live) {
    const iWon = st.winner === this.human;
    let stamp;
    let text;
    let cls = '';
    if (st.winner === null) {
      stamp = '和';
      cls = ' draw';
      text = '同一局面重复三次,判和';
      if (live) this.sound.draw();
    } else if (iWon) {
      stamp = '胜';
      text = st.reason === 'mate' ? '将死对方' : '对方无子可走';
      if (live) this.sound.win();
    } else {
      stamp = '负';
      cls = ' lose';
      text = st.reason === 'mate' ? '被将死' : '无子可走';
      if (live) this.sound.lose();
    }

    this.el.stamp.textContent = stamp;
    this.el.stamp.className = 'stamp' + cls;
    this.el.bannerText.textContent = text;
    this.el.banner.hidden = false;

    if (live && st.lostKing >= 0 && !this.reduceMotion) {
      this.renderer.startWin({ f: fileOf(st.lostKing), r: rankOf(st.lostKing) }, iWon);
    }
    this.statLines(st.reason === 'repetition' ? '重复局面三次' : st.reason === 'mate' ? '将死' : '困毙', '');
    this.say(st.winner === null ? '和棋' : iWon ? '你赢了' : '你输了', iWon ? '' : 'bad');
  }

  /* -------------------------------- display -------------------------------- */

  /** 思考状态还要落到 canvas 的类上,光标才会变成 progress。 */
  thinking(on) {
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

  /** 状态栏那两行读数。空串也要写:两行的 min-height 是固定的,
      思考中和思考结束占的高度一样,栏里下面的块才不会上下跳。 */
  statLines(a, b) {
    this.el.statA.textContent = a;
    this.el.statB.textContent = b;
  }

  /** 思考时实时报数。用 setTimeout 链而不是 rAF —— 后台标签页里 rAF 会被冻住,
      而且搜索本身就在占着主线程,rAF 排不上。 */
  startStatTimer() {
    this.stopStatTimer();
    const tick = () => {
      const s = AI.current;
      if (!s) return;
      this.statLines(
        `电脑 · ${s.completeDepth} 层 · ${((performance.now() - s.started) / 1000).toFixed(1)} 秒`,
        `${fmtNum(s.nodes)} 个局面`,
      );
      this.statTimer = setTimeout(tick, 200);
    };
    this.statTimer = setTimeout(tick, 200);
  }

  stopStatTimer() {
    if (!this.statTimer) return;
    clearTimeout(this.statTimer);
    this.statTimer = 0;
  }

  updateUndo() {
    const has = !!this.branches[this.bi].moves.length;
    this.el.undo.disabled = !has || AI.busy;
    this.el.exportBtn.disabled = !has;
    this.el.copyBtn.disabled = !has;
  }

  /* -------------------------------- 棋谱进出 -------------------------------- */

  /** 按回合排成 "1. 炮二平五 砲2进7"。导入时序号会被剥掉,所以怎么写都能读回来。
      只出选中分支 —— 下拉停在哪儿就导出哪儿。 */
  movesText() {
    const h = this.branches[this.bi].moves;
    const lines = [];
    for (let i = 0; i < h.length; i += 2) {
      const red = h[i] ? h[i].text || '·' : '';
      const black = h[i + 1] ? h[i + 1].text || '·' : '';
      lines.push(`${(i >> 1) + 1}. ${red}${black ? ' ' + black : ''}`);
    }
    return lines.join('\n');
  }

  stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  exportMoves() {
    const text = this.movesText();
    if (!text) return;
    // BOM不能省:Windows 记事本没有它就按本地编码猜,中文棋谱直接成乱码。
    // 写成转义而不是字面字符,因为它在源码里看不见。
    const blob = new Blob(['\uFEFF' + text + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xq_${this.stamp()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.say('棋谱已导出', '');
  }

  readFile(file) {
    const reader = new FileReader();
    reader.onload = () => this.loadMoves(String(reader.result));
    reader.onerror = () => this.say('这个文件读不出来', 'bad');
    reader.readAsText(file, 'utf-8');
  }

  /** 换行、空格、中英文逗号都算分隔;行首的 "1." 这类序号剥掉。 */
  parseMoves(text) {
    const out = [];
    for (let t of text.replace(/^\uFEFF/, '').split(/[\s,，。;；]+/)) {
      t = t.replace(/^\d+\s*[.、)]\s*/, '');
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * 导入不写记谱解析器:拿每一手去比对当前局面每个合法着法生成的记谱,相等就是它。
   * 记谱在给定局面下本来就是唯一的(同线的歧义已经由前/中/后消掉了),所以匹配得上
   * 那一手必然是那一手,匹配不上就是这局走到这儿不通。
   *
   * 先在临时局面里走完,走通了才换掉当前对局 —— 半途报错不能把棋盘留在中间状态。
   */
  loadMoves(text) {
    const tokens = this.parseMoves(text);
    if (!tokens.length) {
      this.say('没读到棋谱', 'bad');
      this.sound.reject();
      return;
    }
    // 文件和粘贴都汇到这儿,所以确认写在这里才两边都拦得住。
    const dirty = this.branches.some((br) => br.moves.length) && !this.over;
    if (dirty && !confirm('导入会替换当前对局和所有分支,继续?')) return;

    const b = new Board();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const m = b.legalMoves(b.current).find((x) => notate(b, x) === t);
      if (!m) {
        this.say(`第 ${i + 1} 手读不通:${t}`, 'bad');
        this.sound.reject();
        return;
      }
      m.text = t;
      b.make(m);
    }

    // 导入清空所有分支,只留这一条;走通了才换,半途报错棋盘不动。
    this.branches = [{ moves: b.history.slice() }];
    this.setView(0, b.history.length);
    this.say(`已导入 ${tokens.length} 手`, '');
  }

  async copyMoves() {
    const text = this.movesText();
    if (!text) return;
    if (await this.writeClip(text)) this.say('棋谱已复制到剪切板', '');
    else this.say('浏览器不让访问剪切板', 'bad');
  }

  /** 异步剪切板 API 要安全上下文,file:// 下不一定有,所以留一条 execCommand 退路。 */
  async writeClip(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* 往下退 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  async pasteMoves() {
    let text = null;
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      text = null; // 权限被拒,或这个浏览器根本不读剪切板
    }
    if (text === null) this.askPaste();
    else this.loadMoves(text);
  }

  /** 读不到剪切板就改成让用户自己按 Ctrl+V:聚焦一个看不见的输入框接 paste 事件。 */
  askPaste() {
    const ta = this.el.pasteBox;
    ta.value = '';
    ta.focus();
    this.say('请按 Ctrl+V 粘贴棋谱', 'thinking');
    ta.addEventListener('paste', (e) => {
      const text = e.clipboardData ? e.clipboardData.getData('text') : '';
      ta.value = '';
      ta.blur();
      if (text) this.loadMoves(text);
      else this.say('剪切板里没有内容', 'bad');
    }, { once: true });
  }

  /** 棋谱每次整体重建:悔棋要缩短它,导航要挪高亮,重建成本来就不长,比做增量对账省事。
      数据源是选中分支的完整记录;at 之后的那些手照样列出来,但变灰 —— 棋盘还没走到那儿。 */
  renderMoves(flash) {
    const h = this.branches[this.bi].moves;
    const frag = document.createDocumentFragment();
    let now = null;
    for (let i = 0; i < h.length; i++) {
      if (i % 2 === 0) {
        const no = document.createElement('span');
        no.className = 'no';
        no.textContent = String((i >> 1) + 1);
        frag.appendChild(no);
      }
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'mv' + (sideOf(h[i].v) === RED ? ' red' : '') + (i >= this.at ? ' future' : '');
      cell.textContent = h[i].text || '·';
      cell.dataset.i = String(i);
      frag.appendChild(cell);
      if (i === this.at - 1) now = cell;
    }
    this.el.moves.textContent = '';
    this.el.moves.appendChild(frag);
    if (!now) return;
    now.classList.add('now');
    if (flash && !this.reduceMotion) now.classList.add('flash');
    const box = this.el.moves;
    box.scrollTop = Math.max(0, now.offsetTop - box.clientHeight / 2);
  }
}

window.addEventListener('DOMContentLoaded', () => new Game());
