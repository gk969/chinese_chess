/**
 * 象棋规则:9×10 交叉点、走法生成、将军/将死/困毙、Zobrist 与重复局面。
 * 不碰 DOM,可以直接在控制台 new Board() 自测。
 */

const COLS = 9;
const ROWS = 10;
const CELLS = COLS * ROWS;

const EMPTY = 0;
const RED = 1;
const BLACK = 2;

const T_KING = 1, T_ADVISOR = 2, T_ELEPHANT = 3, T_HORSE = 4, T_ROOK = 5, T_CANNON = 6, T_PAWN = 7;

const makePiece = (side, type) => (side << 3) | type;
const sideOf = (v) => v >> 3;
const typeOf = (v) => v & 7;
const other = (c) => (c === RED ? BLACK : RED);

const sq = (f, r) => r * COLS + f;
const fileOf = (i) => i % COLS;
const rankOf = (i) => (i / COLS) | 0;
const onBoard = (f, r) => f >= 0 && f < COLS && r >= 0 && r < ROWS;

/** 河在 r=4 与 r=5 之间:红方半场 r>=5,黑方半场 r<=4。 */
const homeHalf = (r, side) => (side === RED ? r >= 5 : r <= 4);
const inPalace = (f, r, side) =>
  onBoard(f, r) && f >= 3 && f <= 5 && (side === RED ? r >= 7 : r <= 2);

const PIECE_CHARS = {
  [RED]: { [T_KING]: '帥', [T_ADVISOR]: '仕', [T_ELEPHANT]: '相', [T_HORSE]: '馬', [T_ROOK]: '車', [T_CANNON]: '炮', [T_PAWN]: '兵' },
  [BLACK]: { [T_KING]: '將', [T_ADVISOR]: '士', [T_ELEPHANT]: '象', [T_HORSE]: '馬', [T_ROOK]: '車', [T_CANNON]: '砲', [T_PAWN]: '卒' },
};

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const HORSE_JUMPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

const BACK_RANK = [T_ROOK, T_HORSE, T_ELEPHANT, T_ADVISOR, T_KING, T_ADVISOR, T_ELEPHANT, T_HORSE, T_ROOK];

/* --------------------------------- hashing -------------------------------- */

// 兵种编码最大 23(黑車=2<<3|7),所以每格 24 个槽。拆成两个 Int32 当 64 位用。
const ZOB_LO = new Int32Array(CELLS * 24);
const ZOB_HI = new Int32Array(CELLS * 24);
let TURN_LO = 0;
let TURN_HI = 0;
{
  let s = 0x9e3779b9 | 0;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    return s;
  };
  for (let i = 0; i < ZOB_LO.length; i++) {
    ZOB_LO[i] = rnd();
    ZOB_HI[i] = rnd();
  }
  TURN_LO = rnd();
  TURN_HI = rnd();
}

class Board {
  constructor() {
    this.grid = new Uint8Array(CELLS);
    this.kings = new Int8Array(3); // 索引 = side
    this.history = [];
    this.keyLo = [];
    this.keyHi = [];
    this.zobLo = 0;
    this.zobHi = 0;
    this.current = RED;
    this.reset();
  }

  reset() {
    this.grid.fill(EMPTY);
    for (let f = 0; f < COLS; f++) {
      this.grid[sq(f, 0)] = makePiece(BLACK, BACK_RANK[f]);
      this.grid[sq(f, 9)] = makePiece(RED, BACK_RANK[f]);
    }
    for (const f of [1, 7]) {
      this.grid[sq(f, 2)] = makePiece(BLACK, T_CANNON);
      this.grid[sq(f, 7)] = makePiece(RED, T_CANNON);
    }
    for (const f of [0, 2, 4, 6, 8]) {
      this.grid[sq(f, 3)] = makePiece(BLACK, T_PAWN);
      this.grid[sq(f, 6)] = makePiece(RED, T_PAWN);
    }
    this.current = RED;
    this.history = [];
    this.rehash();
    this.keyLo = [this.zobLo];
    this.keyHi = [this.zobHi];
    return this;
  }

  /** 从外部局面装载(搜索用)。 */
  load(grid, current) {
    this.grid.set(grid);
    this.current = current;
    this.history = [];
    this.rehash();
    this.keyLo = [this.zobLo];
    this.keyHi = [this.zobHi];
    return this;
  }

  rehash() {
    this.zobLo = 0;
    this.zobHi = 0;
    for (let i = 0; i < 3; i++) this.kings[i] = -1;
    for (let i = 0; i < CELLS; i++) {
      const v = this.grid[i];
      if (v === EMPTY) continue;
      this.zobLo ^= ZOB_LO[i * 24 + v];
      this.zobHi ^= ZOB_HI[i * 24 + v];
      if (typeOf(v) === T_KING) this.kings[sideOf(v)] = i;
    }
    // make/unmake 每手都翻 TURN,全量重算必须按当前走子方补上同一个键,
    // 否则增量哈希和 rehash 永远差一个 TURN。
    if (this.current === BLACK) {
      this.zobLo ^= TURN_LO;
      this.zobHi ^= TURN_HI;
    }
  }

  at(f, r) { return this.grid[sq(f, r)]; }
  isEmpty(f, r) { return this.grid[sq(f, r)] === EMPTY; }
  isOwn(v, color) { return v !== EMPTY && sideOf(v) === color; }
  isEnemy(v, color) { return v !== EMPTY && sideOf(v) !== color; }
  findKing(color) { return this.kings[color]; }

  /* ------------------------------ move making ----------------------------- */

  /** m = {f, r, tf, tr}。走之前算好的记谱挂在 m.text 上,原样带进 history。 */
  make(m) {
    const from = sq(m.f, m.r);
    const to = sq(m.tf, m.tr);
    const v = this.grid[from];
    const cap = this.grid[to];
    this.history.push({ m, v, cap, king: this.kings[this.current], text: m.text || null });

    this.zobLo ^= ZOB_LO[from * 24 + v] ^ ZOB_LO[to * 24 + v];
    this.zobHi ^= ZOB_HI[from * 24 + v] ^ ZOB_HI[to * 24 + v];
    if (cap !== EMPTY) {
      this.zobLo ^= ZOB_LO[to * 24 + cap];
      this.zobHi ^= ZOB_HI[to * 24 + cap];
    }
    this.zobLo ^= TURN_LO;
    this.zobHi ^= TURN_HI;

    this.grid[to] = v;
    this.grid[from] = EMPTY;
    if (typeOf(v) === T_KING) this.kings[this.current] = to;
    this.current = other(this.current);
    this.keyLo.push(this.zobLo);
    this.keyHi.push(this.zobHi);
    return cap;
  }

  unmake() {
    const h = this.history.pop();
    if (!h) return;
    this.current = other(this.current);
    const from = sq(h.m.f, h.m.r);
    const to = sq(h.m.tf, h.m.tr);
    this.grid[from] = h.v;
    this.grid[to] = h.cap;
    if (typeOf(h.v) === T_KING) this.kings[this.current] = h.king;
    this.zobLo ^= ZOB_LO[from * 24 + h.v] ^ ZOB_LO[to * 24 + h.v];
    this.zobHi ^= ZOB_HI[from * 24 + h.v] ^ ZOB_HI[to * 24 + h.v];
    if (h.cap !== EMPTY) {
      this.zobLo ^= ZOB_LO[to * 24 + h.cap];
      this.zobHi ^= ZOB_HI[to * 24 + h.cap];
    }
    this.zobLo ^= TURN_LO;
    this.zobHi ^= TURN_HI;
    this.keyLo.pop();
    this.keyHi.pop();
  }

  undo() { this.unmake(); }

  /* ------------------------------- attacking ------------------------------ */

  /**
   * 格子 i 是否被 by 方的任一子攻击。反向查:从 i 出发找能打到这里的子。
   * 白脸将靠"竖线第一个子是对方将/帅"这条覆盖,不需要单独判。
   */
  attacked(i, by) {
    if (i < 0) return true;
    const f = fileOf(i);
    const r = rankOf(i);
    const g = this.grid;

    for (const [df, dr] of ORTHO) {
      let cf = f + df;
      let cr = r + dr;
      let screen = 0;
      while (onBoard(cf, cr)) {
        const v = g[sq(cf, cr)];
        if (v !== EMPTY) {
          if (sideOf(v) === by) {
            const t = typeOf(v);
            if (screen === 0) {
              if (t === T_ROOK) return true;
              // 两个将/帅永远在各自的九宫,只有同一条竖线才可能照面。
              if (t === T_KING && df === 0) return true;
            } else if (t === T_CANNON) {
              return true;
            }
          }
          screen++;
          if (screen > 1) break;
        }
        cf += df;
        cr += dr;
      }
    }

    for (const [df, dr] of HORSE_JUMPS) {
      const hf = f - df;
      const hr = r - dr;
      if (!onBoard(hf, hr)) continue;
      const v = g[sq(hf, hr)];
      if (!this.isOwn(v, by) || typeOf(v) !== T_HORSE) continue;
      // 蹩腿是马朝落点方向相邻的那一格。
      const lf = hf + (df === 2 ? 1 : df === -2 ? -1 : 0);
      const lr = hr + (dr === 2 ? 1 : dr === -2 ? -1 : 0);
      if (g[sq(lf, lr)] !== EMPTY) continue;
      return true;
    }

    for (const [df, dr] of DIAG) {
      const ef = f - df * 2;
      const er = r - dr * 2;
      if (!onBoard(ef, er)) continue;
      const v = g[sq(ef, er)];
      if (!this.isOwn(v, by) || typeOf(v) !== T_ELEPHANT) continue;
      if (!homeHalf(r, by)) continue; // 象不能过河,打不到河对岸
      if (g[sq(ef + df, er + dr)] !== EMPTY) continue; // 塞象眼
      return true;
    }

    const dir = by === RED ? -1 : 1;
    {
      const pr = r - dir; // 兵在 (f,pr) 时正前进到 (f,r)
      if (onBoard(f, pr)) {
        const v = g[sq(f, pr)];
        if (this.isOwn(v, by) && typeOf(v) === T_PAWN) return true;
      }
      if (!homeHalf(r, by)) { // 已过河的兵还能吃左右
        for (const df of [-1, 1]) {
          const sf = f + df;
          if (!onBoard(sf, r)) continue;
          const v = g[sq(sf, r)];
          if (this.isOwn(v, by) && typeOf(v) === T_PAWN) return true;
        }
      }
    }

    return false;
  }

  inCheck(color) { return this.attacked(this.kings[color], other(color)); }

  /* ------------------------------ generation ----------------------------- */

  /** 伪合法着法:不判走完是否被将。搜索用这个,配合"吃到将就是赢"。 */
  genPseudo(color) {
    const out = [];
    const g = this.grid;
    for (let r = 0; r < ROWS; r++) {
      for (let f = 0; f < COLS; f++) {
        const v = g[sq(f, r)];
        if (!this.isOwn(v, color)) continue;
        switch (typeOf(v)) {
          case T_KING: this.genKing(f, r, color, out); break;
          case T_ADVISOR: this.genAdvisor(f, r, color, out); break;
          case T_ELEPHANT: this.genElephant(f, r, color, out); break;
          case T_HORSE: this.genHorse(f, r, color, out); break;
          case T_ROOK: this.genRook(f, r, color, out); break;
          case T_CANNON: this.genCannon(f, r, color, out); break;
          case T_PAWN: this.genPawn(f, r, color, out); break;
        }
      }
    }
    return out;
  }

  /** 合法着法:走完自己的将不能被攻击。 */
  legalMoves(color) {
    const out = [];
    for (const m of this.genPseudo(color)) {
      this.make(m);
      if (!this.attacked(this.kings[color], other(color))) out.push(m);
      this.unmake();
    }
    return out;
  }

  push(out, f, r, tf, tr) { out.push({ f, r, tf, tr }); }

  /** 空格和敌子都能去,只有己方子挡住。 */
  canLand(f, r, color) { return !this.isOwn(this.at(f, r), color); }

  genKing(f, r, color, out) {
    for (const [df, dr] of ORTHO) {
      const nf = f + df;
      const nr = r + dr;
      if (!inPalace(nf, nr, color)) continue;
      if (this.canLand(nf, nr, color)) this.push(out, f, r, nf, nr);
    }
  }

  genAdvisor(f, r, color, out) {
    for (const [df, dr] of DIAG) {
      const nf = f + df;
      const nr = r + dr;
      if (!inPalace(nf, nr, color)) continue;
      if (this.canLand(nf, nr, color)) this.push(out, f, r, nf, nr);
    }
  }

  genElephant(f, r, color, out) {
    for (const [df, dr] of DIAG) {
      const nf = f + df * 2;
      const nr = r + dr * 2;
      if (!onBoard(nf, nr)) continue;
      if (!homeHalf(nr, color)) continue;          // 象不能过河
      if (this.at(f + df, r + dr) !== EMPTY) continue; // 塞象眼
      if (this.canLand(nf, nr, color)) this.push(out, f, r, nf, nr);
    }
  }

  genHorse(f, r, color, out) {
    for (const [df, dr] of HORSE_JUMPS) {
      const nf = f + df;
      const nr = r + dr;
      if (!onBoard(nf, nr)) continue;
      const lf = f + (df === 2 ? 1 : df === -2 ? -1 : 0);
      const lr = r + (dr === 2 ? 1 : dr === -2 ? -1 : 0);
      if (this.at(lf, lr) !== EMPTY) continue;     // 蹩马腿
      if (this.canLand(nf, nr, color)) this.push(out, f, r, nf, nr);
    }
  }

  genRook(f, r, color, out) {
    for (const [df, dr] of ORTHO) {
      let nf = f + df;
      let nr = r + dr;
      while (onBoard(nf, nr)) {
        const t = this.at(nf, nr);
        if (t === EMPTY) this.push(out, f, r, nf, nr);
        else {
          if (this.isEnemy(t, color)) this.push(out, f, r, nf, nr);
          break;
        }
        nf += df;
        nr += dr;
      }
    }
  }

  genCannon(f, r, color, out) {
    for (const [df, dr] of ORTHO) {
      let nf = f + df;
      let nr = r + dr;
      while (onBoard(nf, nr)) { // 平移:和车一样,但不能越子
        const t = this.at(nf, nr);
        if (t === EMPTY) this.push(out, f, r, nf, nr);
        else break;
        nf += df;
        nr += dr;
      }
      // 翻一个炮架之后,第一个敌子可吃
      while (onBoard(nf, nr) && this.at(nf, nr) === EMPTY) { nf += df; nr += dr; }
      nf += df;
      nr += dr;
      while (onBoard(nf, nr)) {
        const t = this.at(nf, nr);
        if (t !== EMPTY) {
          if (this.isEnemy(t, color)) this.push(out, f, r, nf, nr);
          break;
        }
        nf += df;
        nr += dr;
      }
    }
  }

  genPawn(f, r, color, out) {
    const dir = color === RED ? -1 : 1;
    const tryTo = (nf, nr) => {
      if (onBoard(nf, nr) && this.canLand(nf, nr, color)) this.push(out, f, r, nf, nr);
    };
    tryTo(f, r + dir);
    if (!homeHalf(r, color)) { // 过河后能横走,永远不能后退
      tryTo(f - 1, r);
      tryTo(f + 1, r);
    }
  }

  /* -------------------------------- outcome ------------------------------- */

  /** 同一局面(含走子方)第三次出现判和。完整的长将/长捉判负规则不在实现范围内。 */
  repetitionCount() {
    const lo = this.zobLo;
    const hi = this.zobHi;
    let n = 0;
    for (let i = this.keyLo.length - 1; i >= 0; i--) {
      if (this.keyLo[i] === lo && this.keyHi[i] === hi) n++;
    }
    return n;
  }

  /**
   * { over, winner, reason, lostKing }
   * 象棋里没有和棋的常规判据,困毙(无子可走但没被将)同样判负。
   */
  gameState() {
    if (this.repetitionCount() >= 3) return { over: true, winner: null, reason: 'repetition', lostKing: -1 };
    if (!this.legalMoves(this.current).length) {
      const loser = this.current;
      return {
        over: true,
        winner: other(loser),
        reason: this.inCheck(loser) ? 'mate' : 'stalemate',
        lostKing: this.kings[loser],
      };
    }
    return { over: false, winner: 0, reason: '', lostKing: -1 };
  }
}
