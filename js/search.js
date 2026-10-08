/**
 * 电脑的大脑:迭代加深 negamax + α-β 剪枝 + 静态搜索 + 置换表 + 着法排序。
 *
 * 没有 Web Worker —— `file://` 下 Worker 起不来,所以搜索只能在主线程上切片跑:
 * 每片跑 SLICE_MS 毫秒就抛哨兵退出,用 MessageChannel 排下一片,浏览器在两片之间照常画帧。
 * 根节点的着法循环是可续跑的(见 beginRoot/rootStep/commitRoot):一层要跨好几片才搜得完,
 * 每片都从头重搜的话 α 攒不起来,2.5 秒会全花在重搜同一层上。
 */

/**
 * 三档难度。
 * blunder = 低档"漏防"的概率:直接随机挑一步合法着法。
 * spread  = 允许在最好着法多少分以内随机挑,让中低档每局不一样。
 */
const PROFILES = {
  low: { depth: 2, rootCap: 10, innerCap: 12, qDepth: 0, budget: 120, tt: false, blunder: 0.35, spread: 80 },
  mid: { depth: 7, rootCap: 24, innerCap: 24, qDepth: 4, budget: 700, tt: true, blunder: 0, spread: 25 },
  high: { depth: 12, rootCap: 40, innerCap: 32, qDepth: 6, budget: 2500, tt: true, blunder: 0, spread: 0 },
};

const MATE = 30000;
const MATE_EDGE = MATE - 1000; // 超过这条线就算杀棋分,存盘时要按 ply 平移
const INF = 1 << 20;
const SLICE_MS = 40;
// 静态搜索里允许连续应将的层数。给到 3 层时 d4 一层就 5000 万节点,2 层是拐点。
const QS_CHK = 2;
const SLICE = { slice: true };

const FLAG_EXACT = 0;
const FLAG_LOWER = 1;
const FLAG_UPPER = 2;

/* --------------------------------- 置换表 --------------------------------- */

const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_LO = new Int32Array(TT_SIZE);
const TT_HI = new Int32Array(TT_SIZE);
const TT_INFO = new Int32Array(TT_SIZE); // 低 16 位 = 分数+32768,16..21 = 深度,22..23 = 标志
const TT_MOVE = new Int32Array(TT_SIZE); // 存 code+1,0 表示没有
const TT_GEN = new Uint8Array(TT_SIZE); // 世代号,换局不清表
let ttGen = 0;

/* ------------------------------ 子力与位置表 ------------------------------ */

const PIECE_VALUE = [0, 0, 200, 220, 420, 900, 470, 100]; // 下标 = 兵种;将/帅不算子力分

/**
 * 位置表按红方视角写:r=0 是黑方底线(红方前进的方向),每表 10 行 × 9 列。
 * 黑方查表时上下翻转:`PST[t][sq(f, ROWS - 1 - r)]`。数值是在子力分之上的加成。
 */
const PST = {
  [T_PAWN]: [
    90, 100, 105, 110, 115, 110, 105, 100, 90,
    80, 90, 95, 100, 105, 100, 95, 90, 80,
    70, 80, 85, 90, 95, 90, 85, 80, 70,
    60, 70, 75, 80, 85, 80, 75, 70, 60,
    55, 65, 70, 75, 80, 75, 70, 65, 55, // 刚过河
    10, 15, 20, 25, 30, 25, 20, 15, 10, // 本方半场
    0, 0, 0, 0, 0, 0, 0, 0, 0, // 起始线
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [T_HORSE]: [
    -20, 10, 30, 30, 20, 30, 30, 10, -20,
    -10, 20, 50, 60, 50, 60, 50, 20, -10,
    -10, 30, 60, 70, 60, 70, 60, 30, -10, // 卧槽/挂角一带
    -10, 25, 55, 60, 55, 60, 55, 25, -10,
    -10, 25, 55, 60, 55, 60, 55, 25, -10,
    -10, 25, 50, 55, 50, 55, 50, 25, -10,
    -10, 20, 40, 45, 40, 45, 40, 20, -10,
    -10, 15, 30, 35, 30, 35, 30, 15, -10,
    -5, 10, 20, 25, 20, 25, 20, 10, -5,
    -5, -5, 10, 15, 10, 15, 10, -5, -5, // 边线马最差
  ],
  [T_CANNON]: [
    10, 10, 15, 20, 20, 20, 15, 10, 10, // 沉底炮
    10, 15, 20, 25, 25, 25, 20, 15, 10,
    10, 15, 25, 35, 40, 35, 25, 15, 10,
    10, 20, 30, 40, 45, 40, 30, 20, 10, // 压卒林
    10, 20, 30, 40, 45, 40, 30, 20, 10,
    10, 15, 25, 35, 40, 35, 25, 15, 10,
    10, 15, 20, 30, 35, 30, 20, 15, 10,
    5, 10, 15, 20, 25, 20, 15, 10, 5, // 本方炮位
    5, 10, 15, 20, 20, 20, 15, 10, 5,
    0, 5, 10, 10, 10, 10, 10, 5, 0,
  ],
  [T_ROOK]: [
    30, 30, 30, 35, 40, 35, 30, 30, 30, // 沉底车
    30, 35, 40, 45, 50, 45, 40, 35, 30,
    25, 30, 35, 40, 45, 40, 35, 30, 25,
    20, 25, 30, 35, 40, 35, 30, 25, 20,
    15, 20, 25, 30, 35, 30, 25, 20, 15,
    10, 15, 20, 25, 30, 25, 20, 15, 10,
    5, 10, 15, 20, 25, 20, 15, 10, 5,
    0, 5, 10, 15, 20, 15, 10, 5, 0,
    0, 5, 10, 15, 20, 15, 10, 5, 0,
    0, 5, 10, 15, 20, 15, 10, 5, 0,
  ],
  [T_ADVISOR]: [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 8, 0, 0, 0, 0, // 中仕
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [T_ELEPHANT]: [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 12, 0, 0, 0, 0, // 河口中相
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 14, 0, 0, 0, 0, // 中相
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
};

/* --------------------------------- 搜索 ---------------------------------- */

class Search {
  constructor(board, profile) {
    this.b = board;
    this.p = profile;
    this.nodes = 0;
    this.depth = 1;
    this.completeDepth = 0;
    this.best = null;
    this.bestScore = 0;
    this.pool = [];
    this.legal = [];
    this.finished = false;
    this.cancelled = false;
    this.started = performance.now();
    this.deadline = this.started + profile.budget;
    this.sliceDeadline = this.started + SLICE_MS;
    // SLICE 是从递归深处直接抛出来的,中间的 make() 一个都没 unmake,
    // 所以每片结束都要把局面退回根,否则下一片是在一盘被走烂的棋上搜。
    this.baseHistory = board.history.length;
    this.nullDepth = 0;
    this.iterDepth = 0; // 正在搜的那一层;0 = 还没开始
    this.rootI = 0;
    ttGen = (ttGen % 255) + 1; // 世代号必须非 0,0 是"空槽"
    this.ttGen = ttGen;
    this.killer = [new Int32Array(64), new Int32Array(64)];
    this.history = new Int32Array(CELLS * CELLS);
  }

  /** 把搜索切成一片一片,片与片之间让出主线程。 */
  start(onDone) {
    const chan = new MessageChannel();
    chan.port1.onmessage = () => {
      if (this.cancelled) {
        chan.port1.close();
        return;
      }
      this.slice();
      if (this.cancelled) {
        chan.port1.close();
        return;
      }
      if (this.finished) {
        chan.port1.close();
        onDone(this.result());
        return;
      }
      chan.port2.postMessage(0);
    };
    chan.port2.postMessage(0);
  }

  cancel() {
    this.cancelled = true;
  }

  slice() {
    this.sliceDeadline = performance.now() + SLICE_MS;
    try {
      while (this.depth <= this.p.depth) {
        if (this.iterDepth !== this.depth) this.beginRoot(this.depth);
        if (!this.rootLimit) break; // 无路可走,这局已经结束了
        this.rootStep(this.depth);
        this.commitRoot(this.depth);
        this.completeDepth = this.depth;
        this.depth++;
        if (performance.now() > this.deadline) break;
      }
      this.finished = true;
    } catch (e) {
      if (e !== SLICE) throw e;
      // 局面退回根:先撤空着(history 里没有它们的痕迹),再撤真着法。
      while (this.nullDepth > 0) this.nullUnmake();
      while (this.b.history.length > this.baseHistory) this.b.unmake();
      if (performance.now() > this.deadline) this.finished = true;
    }
  }

  tick() {
    if ((this.nodes & 1023) !== 0) return;
    const now = performance.now();
    if (now > this.deadline) {
      this.finished = true;
      throw SLICE;
    }
    if (now > this.sliceDeadline) throw SLICE;
  }

  code(m) {
    return (sq(m.f, m.r) * CELLS + sq(m.tf, m.tr)) | 0;
  }

  /**
   * 空着让一手:只翻走子方和 Zobrist 的 TURN 键,不进 history(搜索里不查重复)。
   * 计数是必须的 —— SLICE 可能正抛在空着的子树里,退回根时得把这些也一并撤销,
   * 而 history 里根本没有它们的痕迹。
   */
  nullMake() {
    const b = this.b;
    b.zobLo ^= TURN_LO;
    b.zobHi ^= TURN_HI;
    b.current = other(b.current);
    this.nullDepth++;
  }

  nullUnmake() {
    const b = this.b;
    b.current = other(b.current);
    b.zobLo ^= TURN_LO;
    b.zobHi ^= TURN_HI;
    this.nullDepth--;
  }

  evaluate(side) {
    const g = this.b.grid;
    let s = 0;
    for (let i = 0; i < CELLS; i++) {
      const v = g[i];
      if (v === EMPTY) continue;
      const t = typeOf(v);
      if (t === T_KING) continue;
      const st = sideOf(v);
      const idx = st === RED ? i : sq(fileOf(i), ROWS - 1 - rankOf(i));
      const val = PIECE_VALUE[t] + PST[t][idx];
      s += st === side ? val : -val;
    }
    return s;
  }

  /** 着法排序:置换表着法 → 吃子(MVV-LVA) → 杀手 → 历史。 */
  order(moves, ply, first) {
    const b = this.b;
    const k1 = this.killer[0][ply];
    const k2 = this.killer[1][ply];
    const hist = this.history;
    for (const m of moves) {
      const c = this.code(m);
      const cap = b.at(m.tf, m.tr);
      let sc;
      if (c === first) sc = 4000000;
      else if (cap !== EMPTY) sc = 2000000 + PIECE_VALUE[typeOf(cap)] * 16 - PIECE_VALUE[typeOf(b.at(m.f, m.r))];
      else if (c === k1) sc = 1500000;
      else if (c === k2) sc = 1400000;
      else sc = hist[c];
      m.sc = sc;
    }
    moves.sort((x, y) => y.sc - x.sc);
    return moves;
  }

  setKiller(ply, c) {
    const k = this.killer;
    if (k[0][ply] === c) return;
    k[1][ply] = k[0][ply];
    k[0][ply] = c;
  }

  /* --------------------------------- 根 ---------------------------------- */

  /**
   * 根节点分成"开局准备 / 逐着法搜索 / 提交"三步,是为了让一层能跨片续着跑。
   * 一层搜不完就被 SLICE 打断是常态(depth 4 起步就要几百毫秒,一片只有 40ms),
   * 早先每片都从第 0 个根着法重搜,α 攒不起来、置换表里又全是上一片窄窗口留下的上界,
   * 结果 2.5 秒全花在反复重搜同一层上 —— 层数死活停在 2。
   */
  beginRoot(depth) {
    const b = this.b;
    const moves = b.legalMoves(b.current); // 根节点只要合法着法,棋谱里不能出现送将
    this.legal = moves;
    this.rootLimit = Math.min(moves.length, this.p.rootCap);
    this.iterDepth = depth;
    if (!moves.length) return;

    const idx = (b.zobLo ^ b.zobHi) & TT_MASK;
    let first = -1;
    if (this.p.tt && TT_GEN[idx] === this.ttGen && TT_LO[idx] === b.zobLo && TT_HI[idx] === b.zobHi) {
      first = TT_MOVE[idx] - 1;
    }
    this.order(moves, 0, first);

    this.rootMoves = moves;
    this.rootIdx = idx;
    this.rootI = 0;
    this.rootAlpha = -INF;
    this.rootBest = null;
    this.rootBestScore = -INF;
    this.rootExact = [];
  }

  /** 从 this.rootI 接着搜;被打断时 rootI 正停在那一手上,下一片重搜这一手。 */
  rootStep(depth) {
    const b = this.b;
    for (; this.rootI < this.rootLimit; this.rootI++) {
      const m = this.rootMoves[this.rootI];
      const cap = b.make(m);
      const sc = typeOf(cap) === T_KING ? MATE : -this.negamax(depth - 1, -INF, -this.rootAlpha, 1);
      b.unmake();
      // 只有抬高了 α 的着法拿到的是精确分,可以进随机池;失败的只是上界。
      if (sc > this.rootAlpha) {
        this.rootAlpha = sc;
        this.rootBest = m;
        this.rootBestScore = sc;
        this.rootExact.push({ m, sc });
      }
    }
  }

  commitRoot(depth) {
    if (!this.rootBest) return;
    const b = this.b;
    const pool = this.rootExact.filter((e) => this.rootBestScore - e.sc <= this.p.spread).map((e) => e.m);
    // 整层搜完才提交,搜到一半的那一层不作数。
    this.best = this.rootBest;
    this.bestScore = this.rootBestScore;
    this.pool = pool.length ? pool : [this.rootBest];

    if (this.p.tt) {
      let sc = this.rootBestScore;
      if (sc > MATE_EDGE) sc += depth;
      else if (sc < -MATE_EDGE) sc -= depth;
      const idx = this.rootIdx;
      TT_GEN[idx] = this.ttGen;
      TT_LO[idx] = b.zobLo;
      TT_HI[idx] = b.zobHi;
      TT_INFO[idx] = ((sc + 32768) & 0xffff) | (Math.min(depth, 63) << 16) | (FLAG_EXACT << 22);
      TT_MOVE[idx] = this.code(this.rootBest) + 1;
    }
  }

  /* ------------------------------- 内部节点 ------------------------------- */

  negamax(depth, alpha, beta, ply) {
    this.nodes++;
    this.tick();

    const b = this.b;
    const me = b.current;
    const alphaOrig = alpha;
    const keyLo = b.zobLo;
    const keyHi = b.zobHi;
    const idx = (keyLo ^ keyHi) & TT_MASK;
    let first = -1;

    if (this.p.tt && TT_GEN[idx] === this.ttGen && TT_LO[idx] === keyLo && TT_HI[idx] === keyHi) {
      const info = TT_INFO[idx];
      first = TT_MOVE[idx] - 1;
      if (((info >>> 16) & 63) >= depth) {
        let sc = (info & 0xffff) - 32768;
        if (sc > MATE_EDGE) sc -= ply;
        else if (sc < -MATE_EDGE) sc += ply;
        const flag = (info >>> 22) & 3;
        if (flag === FLAG_EXACT) return sc;
        if (flag === FLAG_LOWER) {
          if (sc > alpha) alpha = sc;
        } else if (sc < beta) {
          beta = sc;
        }
        if (alpha >= beta) return sc;
      }
    }

    // 不做将军延伸:伪合法搜索里"被将"的分支下一手就能吃掉对方的王,本来就停不下来,
    // 延伸只会让 depth 不单调下降、把置换表记录的深度搞乱。该判的将交给 quiesce 的应将分支。
    if (depth <= 0) return this.quiesce(alpha, beta, this.p.qDepth, ply, QS_CHK);

    // 空着让一手:静态分已经 ≥ β 还切不动,那对方也切不动,这个 β 就守住了。
    // 象棋里逼走劣着(zugzwang)很少,深度够时这么剪的误差远小于它省下的时间。
    // 将杀分附近不剪(可能把杀棋剪掉),被将时不剪(让一手等于送吃王)。
    const inChk = b.inCheck(me);
    if (!inChk && depth >= 3 && beta < MATE_EDGE && this.evaluate(me) >= beta) {
      this.nullMake();
      const sc = -this.negamax(depth - 1 - (depth >> 1), -beta, -beta + 1, ply + 1);
      this.nullUnmake();
      if (sc >= beta) return sc;
    }

    const moves = this.order(b.genPseudo(me), ply, first);
    if (!moves.length) return -MATE + ply; // 伪合法着法都没有 = 真的无路可走

    let best = -INF;
    let bestCode = -1;
    let searched = 0;
    const cap = this.p.innerCap;

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      // 吃子排在最前,所以这条只会截断安静着法,不会漏掉任何吃子。
      if (searched >= cap && b.at(m.tf, m.tr) === EMPTY) break;

      const c = this.code(m);
      // 排序靠后的安静着法先少搜两层;真抬高了 α 再补一层重搜。
      // 置换着法不减 —— 它上一轮已经证明过自己。
      const red = !inChk && depth >= 3 && searched >= 4 && c !== first && b.at(m.tf, m.tr) === EMPTY ? (searched >= 12 ? 2 : 1) : 0;

      const captured = b.make(m);
      let sc = typeOf(captured) === T_KING ? MATE - ply : -this.negamax(depth - 1 - red, -beta, -alpha, ply + 1);
      if (red > 0 && sc > alpha && typeOf(captured) !== T_KING) {
        sc = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      }
      b.unmake();
      searched++;

      if (sc > best) {
        best = sc;
        bestCode = c;
        if (sc > alpha) {
          alpha = sc;
          if (sc < beta && captured === EMPTY) this.setKiller(ply, c);
        }
      }
      if (alpha >= beta) {
        if (captured === EMPTY) this.history[c] += depth * depth;
        break;
      }
    }

    if (this.p.tt) {
      const flag = best <= alphaOrig ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT;
      let sc = best;
      if (sc > MATE_EDGE) sc += ply;
      else if (sc < -MATE_EDGE) sc -= ply;
      TT_GEN[idx] = this.ttGen;
      TT_LO[idx] = keyLo;
      TT_HI[idx] = keyHi;
      TT_INFO[idx] = ((sc + 32768) & 0xffff) | (Math.min(depth, 63) << 16) | (flag << 22);
      TT_MOVE[idx] = bestCode + 1;
    }
    return best;
  }

  /**
   * 静态搜索:象棋里兑子太密集,不搜吃子会一路白送。
   * 平时只搜吃子 + 站住静态分,并用 delta 剪枝跳过明显补不回来的吃子;
   * 被将时静态分毫无意义,要搜全部应着,否则叶子节点会"看不见"正在被将 ——
   * 但连将链必须封顶:每层都摊开全部应着就是 45^qd,实测一层 d4 里 5000 万个节点
   * 有 4100 万是应将,主搜索反而只剩 541 个。所以连续应将只给 QS_CHK 层。
   */
  quiesce(alpha, beta, qd, ply, chk) {
    this.nodes++;
    this.tick();

    const b = this.b;
    const me = b.current;
    if (ply >= 60) return this.evaluate(me);
    const inChk = b.inCheck(me);
    let stand = 0;
    let moves;

    if (inChk) {
      // 超出应将预算就退回静态分:主搜索自己有深度,不会真的看不见这步将。
      if (qd <= 0 || chk <= 0) return this.evaluate(me);
      const idx = (b.zobLo ^ b.zobHi) & TT_MASK;
      let first = -1;
      if (this.p.tt && TT_GEN[idx] === this.ttGen && TT_LO[idx] === b.zobLo && TT_HI[idx] === b.zobHi) {
        first = TT_MOVE[idx] - 1;
      }
      moves = this.order(b.genPseudo(me), ply, first);
      if (!moves.length) return -MATE + ply;
    } else {
      chk = QS_CHK; // 不在将,重新给满应将预算
      stand = this.evaluate(me);
      if (stand >= beta) return stand;
      if (qd <= 0) return stand;
      if (stand > alpha) alpha = stand;
      moves = [];
      for (const m of b.genPseudo(me)) {
        const cap = b.at(m.tf, m.tr);
        if (cap === EMPTY) continue;
        m.sc = 2000000 + PIECE_VALUE[typeOf(cap)] * 16 - PIECE_VALUE[typeOf(b.at(m.f, m.r))];
        moves.push(m);
      }
      moves.sort((x, y) => y.sc - x.sc);
    }

    for (const m of moves) {
      const cap = b.at(m.tf, m.tr);
      if (!inChk && typeOf(cap) !== T_KING && stand + PIECE_VALUE[typeOf(cap)] + 150 < alpha) continue;
      const captured = b.make(m);
      const sc = typeOf(captured) === T_KING ? MATE - ply : -this.quiesce(-beta, -alpha, qd - 1, ply + 1, inChk ? chk - 1 : chk);
      b.unmake();
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) break;
    }
    return alpha;
  }

  /* -------------------------------- 结果 --------------------------------- */

  result() {
    const p = this.p;
    let move = this.best;
    if (move) {
      if (p.blunder > 0 && Math.random() < p.blunder) {
        move = this.legal[(Math.random() * this.legal.length) | 0];
      } else if (this.pool.length > 1) {
        move = this.pool[(Math.random() * this.pool.length) | 0];
      }
    } else if (this.legal.length) {
      move = this.legal[(Math.random() * this.legal.length) | 0];
    }
    return {
      move,
      score: this.bestScore,
      depth: this.completeDepth,
      nodes: this.nodes,
      elapsed: performance.now() - this.started,
    };
  }
}
