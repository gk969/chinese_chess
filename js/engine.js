/**
 * WASM 引擎(Pikafish-HCE)适配层。引擎跑在 Worker 里,这是整个写法的前提:
 *
 * 这个构建只在读命令那一处让出,一次 `go` 从发起到 bestmove 全程占死它所在的线程。
 * 放在主线程上就是冻住页面,所以只能按层切片下发。放进 Worker 之后主线程始终活着,
 * 一次思考就是干干净净的一条 `go movetime N` —— 实测 info 行是实时吐出来的
 * (3 秒一手在 6/7/8/…/3002 ms 各到一条),状态栏的读数照刷不误,不用再切。
 *
 * Worker 的源码必须是页面上已有的字符串:file:// 下 Chrome 既不让
 * `new Worker('engine/pikafish-hce.js')`(origin 是 'null'),blob Worker 里也不让
 * importScripts。所以 glue 由 engine/build/make_worker.sh 编成 window.XQ_WORKER_JS,
 * 做成 blob: URL 起;wasm 仍是 base64,Worker 起来之后 postMessage 进去。
 *
 * Worker 起不来(别的浏览器在 file:// 下另有限制)就退回页内实例化:搜索策略完全一样,
 * 代价是主线程会被一手棋占住。
 */

const Engine = {
  sf: null,        // 页内实例化时才用
  worker: null,
  mode: '',        // 'worker' | 'page'
  state: 'boot',   // boot -> ready,或 failed
  error: '',
  queue: [],
  waiter: null,
  waiters: [],
  gen: 0,          // 每次(重)启动加一号,据此丢掉上一次启动的收尾

  start() { this.reboot(); },

  /** 起引擎并做完 UCI 握手。悔棋/重开打断一手棋时也要重起,见 think().cancel。 */
  async reboot() {
    const gen = ++this.gen;
    this.state = 'boot';
    this.dropWorker();
    this.sf = null;
    this.queue = [];
    this.waiter = null;

    try {
      if (!window.XQ_WASM_B64) throw new Error('没加载到 engine/wasm64.js');
      if (window.XQ_WORKER_JS) {
        try {
          await this.bootWorker();
        } catch (e) {
          // 起 Worker 失败才走这条路,不是兜着错误:页内实例化照样能下,只是会卡。
          this.dropWorker();
          await this.bootPage();
        }
      } else {
        await this.bootPage();
      }
      await this.handshake();
      if (gen !== this.gen) return;
      this.settle('ready');
    } catch (e) {
      if (gen !== this.gen) return;
      this.fail(String((e && e.message) || e));
    }
  },

  bootWorker() {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(new Blob([window.XQ_WORKER_JS], { type: 'text/javascript' }));
      const w = new Worker(url);
      URL.revokeObjectURL(url);

      let booted = false;
      const timer = setTimeout(() => rej(new Error('引擎 Worker 启动超时')), 30000);
      w.onmessage = (e) => {
        const m = e.data || {};
        if (m.started) { clearTimeout(timer); booted = true; res(); return; }
        if (m.fatal) { clearTimeout(timer); rej(new Error(m.fatal)); return; }
        if (m.out !== undefined) this.put(m.out);
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        // 已经起好之后才出错:没有第二次机会了,直接如实报失败。
        booted ? this.fail('引擎 Worker 中断:' + (e.message || '')) : rej(new Error(e.message || '引擎 Worker 出错'));
      };

      this.worker = w;
      this.mode = 'worker';
      w.postMessage({ b64: window.XQ_WASM_B64 });
    });
  },

  bootPage() {
    const b64 = window.XQ_WASM_B64;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    this.mode = 'page';
    return PikafishHCE({
      instantiateWasm: (imports, receiveInstance) =>
        WebAssembly.compile(bytes)
          .then((m) => new WebAssembly.Instance(m, imports))
          .then(receiveInstance),
    }).then((sf) => {
      this.sf = sf;
      sf.addMessageListener((line) => this.put(line));
    });
  },

  async handshake() {
    this.send('uci');
    await this.until('uciok');
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 64');
    this.send('setoption name MultiPV value 1');
    this.send('isready');
    await this.until('readyok');
  },

  dropWorker() {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
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

  send(line) {
    if (this.mode === 'worker') { if (this.worker) this.worker.postMessage({ cmd: line }); }
    else if (this.sf) this.sf.postMessage(line);
  },

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

  /**
   * power = { skill, ms } —— 界面上"电脑棋力"那两个下拉直接交过来,这里不再有档位表。
   * 返回 { current, done }。current 上的 completeDepth/nodes/started 是给状态栏读的。
   */
  think(board, power) {
    const s = {
      completeDepth: 0,
      nodes: 0,
      started: performance.now(),
      dead: false,
      cancel() {
        if (this.dead) return;
        this.dead = true;
        // `stop` 打不断这个构建:go 就跑在读命令的那个线程上,实测 800ms 时发 stop,
        // 3000ms 的一手照样跑满 3001ms。要立刻腾出引擎只能把 Worker 换掉。
        if (Engine.mode === 'worker') Engine.reboot();
      },
    };
    const done = this.run(board, power, s).then((res) => (s.dead ? null : res));
    return { current: s, done };
  },

  async run(board, power, s) {
    await this.whenReady();
    // 引擎还在 boot 时这一手就被 cancel 掉的话,会一直挂在 waiters 里;重起完成时它会被
    // 唤醒,那就得在这儿收手 —— 否则会给新引擎补发一条 go,和新那手抢同一条输出队列。
    if (s.dead) return null;

    const t0 = performance.now();
    this.send('setoption name Skill Level value ' + power.skill);
    this.send('position fen ' + board.fen());
    this.send('go movetime ' + power.ms);

    let best = '';
    for (;;) {
      const line = await this.next();
      if (line.indexOf('info') === 0) {
        // 只有跑完的整层才会打 info,所以这个 depth 可信。它能高到 245,那不是假读数:
        // 245 是迭代加深的 MAX_PLY 封顶,而已证杀的局面里超过杀距的每一层只要 1~4ms。
        const m = / depth (\d+) .* nodes (\d+)/.exec(line);
        if (m) { s.completeDepth = +m[1]; s.nodes = +m[2]; }
        continue;
      }
      if (line.indexOf('bestmove') === 0) {
        best = line.split(' ')[1] || '';
        break;
      }
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
