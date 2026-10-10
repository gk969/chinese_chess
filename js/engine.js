/**
 * WASM 引擎(Pikafish-HCE)适配层。两个约束决定了这里的写法:
 *
 * 1. 双击 index.html 就得能玩,而 file:// 下 Chrome/Edge 禁 fetch 和 XHR,
 *    .wasm 取不到。所以引擎是 engine/wasm64.js 里的一段 base64,经
 *    Module.instantiateWasm 注入。glue 里的 Module.wasmBinary 是死路:
 *    instantiateArrayBuffer 不接这个参数,转头又按文件名去读第二遍。
 * 2. 这个构建只在读命令那一处让出,一次 `go` 从发起到 bestmove 全程占死主线程。
 *    所以一次思考按层下发 —— go depth 1、2、3……,每层之间让出一次事件循环,
 *    状态栏读数才刷得动、动画才不卡、点击才不会被吞。
 *    按层而不是按节点预算切:实测反复 `go nodes N` 每片都是独立搜索,深度在
 *    13~17 之间乱跳、bestmove 每片换一个,4/5 档会退化成 0.1 秒的棋力。
 */

const TIERS = {
  '1': { skill: 5,  ms: 200 },
  '2': { skill: 8,  ms: 200 },
  '3': { skill: 20, ms: 200 },
  '4': { skill: 20, ms: 600 },
  '5': { skill: 20, ms: 1000 },
  // 6、7 档另加 nodes:单层上限不到位的时限根本花不出去(实测 5 秒档跑到 2.9 秒、
  // 20 层就被掐停了),加深只能靠放宽这一层能搜多少节点。代价见 LAYER_NODES。
  '6': { skill: 20, ms: 2000, nodes: 1000000 },
  '7': { skill: 20, ms: 5000, nodes: 2000000 },
};

/* 单层的节点上限。层与层的时间极不均匀(40 万上限下实测单层中位 1~3ms、p99 370~470ms、
   最长 570~650ms),这个上限是给"主线程一次卡多久"兜底的。它是软的:引擎每隔
   min(1024, nodes/1024) 次根着法才查一次节点数,所以会超一点。掐掉了就停止加深。

   它同时也是深度的天花板,所以 6、7 档按档位放宽。实测最长的一层跟着上限走:
   40 万 ≈ 0.6 秒、100 万 ≈ 1.5 秒、200 万 ≈ 2.3 秒 —— 那是这一手里最长的一次卡顿,
   期间读数不刷、点击排队;而且放宽之后"卡得久"的层从偶发变成常态(200 万档 7.5% 的层
   超过 0.39 秒)。这个构建只在读命令处让出,想在一次迭代里搜得更深就得卡得更久,没有两全。 */
const LAYER_NODES = 400000;

const Engine = {
  sf: null,
  state: 'boot', // boot -> ready,或 failed
  error: '',
  queue: [],
  waiter: null,
  waiters: [],

  start() {
    const b64 = window.XQ_WASM_B64;
    if (!b64) return this.fail('没加载到 engine/wasm64.js');

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    PikafishHCE({
      instantiateWasm: (imports, receiveInstance) =>
        WebAssembly.compile(bytes)
          .then((m) => new WebAssembly.Instance(m, imports))
          .then(receiveInstance)
          .catch((e) => this.fail('编译 wasm 失败:' + (e && e.message || e))),
    })
      .then((sf) => {
        this.sf = sf;
        sf.addMessageListener((line) => this.put(line));
        this.send('uci');
        return this.until('uciok');
      })
      .then(() => {
        this.send('setoption name Threads value 1');
        this.send('setoption name Hash value 64');
        this.send('setoption name MultiPV value 1');
        this.send('isready');
        return this.until('readyok');
      })
      .then(() => this.settle('ready'))
      .catch((e) => this.fail(String((e && e.message) || e)));
  },

  fail(msg) {
    this.error = msg;
    this.settle('failed');
  },

  settle(state) {
    this.state = state;
    for (const w of this.waiters) state === 'ready' ? w.res() : w.rej(new Error(this.error));
    this.waiters = [];
  },

  whenReady() {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'failed') return Promise.reject(new Error(this.error));
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  },

  send(line) { this.sf.postMessage(line); },

  put(line) {
    const s = typeof line === 'string' ? line : String(line);
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(s); }
    else this.queue.push(s);
  },

  next() {
    return new Promise((res) => {
      if (this.queue.length) { res(this.queue.shift()); return; }
      this.waiter = res;
    });
  },

  async until(prefix) {
    for (;;) {
      const s = await this.next();
      if (s.indexOf(prefix) === 0) return s;
    }
  },

  /** ICCS 着法:file a-i,rank 0-9,0 是红方底线 —— 和我们的 r 上下相反。 */
  toMove(board, iccs) {
    const f = iccs.charCodeAt(0) - 97, r = 9 - +iccs[1];
    const tf = iccs.charCodeAt(2) - 97, tr = 9 - +iccs[3];
    return board.legalMoves(board.current).find(
      (m) => m.f === f && m.r === r && m.tf === tf && m.tr === tr,
    ) || null;
  },

  /** 返回 { current, done }。current 上的 completeDepth/nodes/started 是给状态栏读的。 */
  think(board, tier) {
    const t = TIERS[tier] || TIERS['3'];
    const s = {
      completeDepth: 0,
      nodes: 0,
      started: performance.now(),
      dead: false,
      cancel() { this.dead = true; },
    };
    const done = this.run(board, t, s).then((res) => (s.dead ? null : res));
    return { current: s, done };
  },

  async run(board, t, s) {
    await this.whenReady();

    const t0 = performance.now();
    const cap = t.nodes || LAYER_NODES;
    this.send('setoption name Skill Level value ' + t.skill);
    this.send('position fen ' + board.fen());

    let best = '';
    for (let d = 1; ; d++) {
      // 悔棋/重开/换难度打断了这一局:一层跑完就收手,绝不再下发下一条 go,
      // 否则会和紧接着开始的新搜索抢同一条输出队列。
      if (s.dead) return null;
      // 第 1 层永远要跑,不然这一手连个着法都没有。
      if (d > 1 && performance.now() - t0 >= t.ms) break;

      // 此刻引擎正停在 getline 上等下一条命令。让出一个宏任务,浏览器才画得了一帧、
      // 状态栏那个 200ms 定时器才走得了一步:Asyncify 只在真正 await 时才交回控制权,
      // 光靠微任务链浏览器是插不进来的(实测一整秒一次都不刷新)。
      if (d > 1) await new Promise((r) => setTimeout(r, 0));

      this.send('go depth ' + d + ' nodes ' + cap);
      let layerNodes = 0, depth = 0;
      for (;;) {
        const line = await this.next();
        if (line.indexOf('info') === 0) {
          // 只有跑完的整层才会打 info,所以这个 depth 可信。它能高到 245,那不是假读数:
          // 245 是迭代加深的 MAX_PLY 封顶,而已证杀的局面里超过杀距的每一层只要 1~4ms,
          // 200ms 的预算能一路刷到 200 多层。
          const m = / depth (\d+).* nodes (\d+)/.exec(line);
          if (m) { depth = +m[1]; layerNodes = +m[2]; }
          continue;
        }
        if (line.indexOf('bestmove') === 0) {
          best = line.split(' ')[1] || '';
          break;
        }
      }
      s.nodes += layerNodes;
      // 每次 `go depth d` 都从第 1 层重新打 info,所以被节点上限掐掉的那一层报的
      // depth 可能比上一层还小 —— 读数不能倒退。
      if (depth > s.completeDepth) s.completeDepth = depth;
      if (best === '(none)' || !best) break;
      // 这一层被节点上限掐掉了(没跑到 d):再往上只会更贵,到此为止。
      if (depth < d) break;
    }

    const base = { depth: s.completeDepth, nodes: s.nodes, elapsed: performance.now() - t0 };
    if (!best || best === '(none)') return { move: null, ...base }; // 真的无着可走
    const move = this.toMove(board, best);
    // 引擎给的着法在合法着法里找不到 = 坐标接缝对不上,不能当成"无着"糊过去。
    if (!move) return { move: null, error: '引擎着法读不出:' + best, ...base };
    return { move, ...base };
  },
};

Engine.start();
