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
      statA: $('statA'),
      statB: $('statB'),
      difficulty: $('difficulty'),
      difficultyHint: $('difficultyHint'),
      side: $('side'),
      moves: $('moves'),
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
    this.statLines('', '');
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
    const has = !!this.board.history.length;
    this.el.undo.disabled = !has || AI.busy;
    this.el.exportBtn.disabled = !has;
    this.el.copyBtn.disabled = !has;
  }

  /* -------------------------------- 棋谱进出 -------------------------------- */

  /** 按回合排成 "1. 炮二平五 砲2进7"。导入时序号会被剥掉,所以怎么写都能读回来。 */
  movesText() {
    const h = this.board.history;
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
    if (this.board.history.length && !this.over && !confirm('导入会替换当前对局,继续?')) return;

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

    this.token++;
    AI.stop();
    this.stopStatTimer();
    this.thinking(false);
    this.board = b;
    this.over = false;
    this.sel = null;
    this.selMoves = [];

    const last = b.history[b.history.length - 1];
    this.renderer.setBoard(b);
    this.renderer.clearWin();
    this.renderer.setCheck(-1);
    this.renderer.setSelection(null, []);
    this.renderer.setLastMove({ f: last.m.f, r: last.m.r }, { f: last.m.tf, r: last.m.tr });

    this.el.banner.hidden = true;
    this.statLines('', '');
    this.renderMoves();
    this.syncCheck();
    this.updateUndo();
    this.syncTurn();
    this.say(`已导入 ${tokens.length} 手`, '');

    const st = b.gameState();
    if (st.over) this.finish(st);
    else if (b.current !== this.human) this.scheduleAI();
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
