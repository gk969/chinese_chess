# engine/ · Pikafish-HCE 的 WASM 编译产物

`pikafish-hce.wasm` + `pikafish-hce.js` 是把 [Pikafish-HCE](https://github.com/skystarspython/Pikafish-HCE)
编译成**单线程** WASM 后的 UCI 引擎。`build/` 里是把它重新编译出来所需的全部东西。

产物名沿用上游 makefile 的 `stockfish.js` 容易让人误以为是 Stockfish 本体,已改名。
引擎自己在 `uci` 握手里的 `id name` 是 Pikafish-HCE。

对局已经由它跑:`js/engine.js` 是适配层,`js/ai.js` 是它在游戏里的入口,难度七档的参数在
`js/engine.js` 的 `TIERS` 里。旧的 JS 搜索 `js/search.js` 留在仓库里但不再被 `index.html` 加载。

## 来源与许可

- 上游:`https://github.com/skystarspython/Pikafish-HCE`,分支 `main`,
  commit `088b062a4e049583e055c3c13d05124b07a6ef13`
- 该仓库与其官方仓库 `official-pikafish/Pikafish` 的 4 个文件做过字节级哈希比对,确认是同一份源码
- 许可:**GPL-3.0-or-later**(上游 `Copying.txt` 与 FSF 规范文本逐行一致,只差 4 处 URL 写法)

因为项目里打包了这个引擎的编译产物,**整个项目按 GPL-3.0 发布**,见根目录 `LICENSE`。
产物是上游源码的编译结果,所以 GPL 跟着产物一起生效;`build/` 下的补丁脚本和 `utils.h`、
`preamble.js` 作为修改的一部分,同样按 GPL 提供。

## 产物

| 文件 | 大小 | gzip |
|---|---|---|
| `pikafish-hce.wasm` | 530,804 B | 182,898 B |
| `pikafish-hce.js`(加载壳) | 20,466 B | 6,701 B |
| `wasm64.js`(上面那个 `.wasm` 的 base64,生成物) | 707,854 B | 255,173 B |
| `worker64.js`(加载壳 + worker 桥,生成物) | 22,266 B | 7,606 B |

## 游戏里怎么加载

`index.html` 按顺序加载 `pikafish-hce.js`(定义 `PikafishHCE`)、`wasm64.js`(定义
`window.XQ_WASM_B64`)和 `worker64.js`(定义 `window.XQ_WORKER_JS`)。正常路径是
`js/engine.js` 用 `XQ_WORKER_JS` 这个字符串起一个 blob Worker,再把 wasm 的 base64
`postMessage` 进去,由 Worker 自己 `atob` + `WebAssembly.compile`。Worker 起不来才退回页内:
把 base64 解成 `Uint8Array`,经 emscripten 的 `instantiateWasm` 注进去。

**`.wasm` 必须内联,不能按 URL 取**:双击 `index.html` 玩是硬约束,而 `file://` 下
Chrome/Edge 禁 `fetch` 和 XHR。

**Worker 的源码同样必须是页面上已有的字符串**,理由和上面同源,实测三条路:

| 写法 | `file://` 下 |
|---|---|
| `new Worker('engine/pikafish-hce.js')` | ✗ *Script at 'file:///…' cannot be accessed from origin 'null'* |
| blob Worker 里 `importScripts('engine/pikafish-hce.js')` | ✗ failed to load |
| `new Worker(URL.createObjectURL(new Blob([源码字符串])))` | ✓ |

blob Worker 里 `atob` 加 `WebAssembly.compile` 是通的(530,804 B、30 个导出、同步编译 7 毫秒),
所以 wasm 走 `postMessage` 进去而不是让 Worker 自己去取文件。

页内实例化那条路的两个坑,改的时候别踩:

- **`Module.wasmBinary` 在这个构建里是死路。** glue 的 `createWasm` 只在没有
  `instantiateWasm` 时才走 `instantiateArrayBuffer(binaryFile, imports)` —— 那个函数
  根本不接二进制,转头又调 `getWasmBinary()` 按文件名再读一遍,浏览器里直接抛。
  所以只有 `instantiateWasm` 这一条路。
- **glue 里写死的 wasm 文件名还是 `stockfish.wasm`**(`findWasmBinary()`),仓库里却没有
  这个文件 —— 这不是漏文件,因为给了 `instantiateWasm` 后那条分支永远不会执行。

一次 `go` 从发起到 `bestmove` 全程占死它所在的线程(这个构建只在读命令那一处让出),这就是引擎
放进 Worker 的全部理由:占的是 Worker 自己的线程,主线程照常画帧、照常刷读数。所以
`js/engine.js` 一次思考就是干干净净的一条 `go movetime N`,不按层切片。

搜索下发的两个坑:

- **`stop` 打不断这个构建。** `go` 就跑在读命令的那个线程上,实测 800 毫秒时发 `stop`,
  3000 毫秒的一手照样跑满 3001 毫秒。悔棋/重开/换难度要立刻腾出引擎只能 `worker.terminate()`
  再重起(实测 215 毫秒回到 `ready`)。
- **不要改成反复 `go nodes N`。** 实测每片都是独立搜索,深度在 13~17 之间乱跳、
  bestmove 每片换一个。

## 重新生成 `wasm64.js` 和 `worker64.js`

改了 `pikafish-hce.wasm` 之后必须重跑,否则游戏里跑的还是旧引擎:

```bash
sh engine/build/make_b64.sh
```

改了 `pikafish-hce.js`(重新链接)、`build/preamble.js` 或 `build/worker-shim.js` 之后重跑:

```bash
sh engine/build/make_worker.sh
```

`worker-shim.js` 是 Worker 那一侧的桥:收到 `{b64}` 就 `atob` + `WebAssembly.compile` 起引擎,
把引擎的每一行输出 `postMessage({out})` 回页面;之后收到的每条 `{cmd}` 交给 `preamble.js`
定义的 stdin 队列(注意那是 `Module["postMessage"]`,跟 Worker 全局的 `postMessage` 不是一回事)。
glue 按 `-s ENVIRONMENT=web,worker,node` 编,同一份二进制在 Worker 里直接能跑,不需要重编。

编译选项里没有 `-sUSE_PTHREADS=1`,这是硬约束不是取舍:项目要在 `file://` 下双击就能跑,
而 `SharedArrayBuffer` 要求 cross-origin isolation(`Cross-Origin-Opener-Policy` +
`Cross-Origin-Embedder-Policy`),`file://` 给不出来。多线程版本必须架服务器,
所以只出单线程版。

## 对上游源码的 4 处改动

都在 `build/patch*.py` 里,用 `#ifdef __EMSCRIPTEN__` 包住,不影响原生编译:

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/uci.cpp` | `argc == 1` 时改用 `emscripten_utils_getline(cmd)` 读命令 | WASM 里没有 stdin |
| `src/misc.cpp` | 跳过 `getcwd()` 那段 | `-s FILESYSTEM=0`,没有文件系统 |
| `src/thread.{h,cpp}` | 不建 `std::thread`,`start_searching()` 里直接内联跑 `search()` | 单线程 WASM 没有原生线程 |
| `src/tt.cpp` | `clear()` 用 `memset` 代替多线程清零 | 同上 |

`build/utils.h`(拷到上游 `src/emscripten/utils.h`)和 `build/preamble.js`(拷到上游
`emscripten/preamble.js`)是我们写的,不是上游文件。`preamble.js` 是单线程 UCI 桥:
`postMessage` → stdin 队列,`print`/`printErr` → 监听者列表。

## 重新编译

需要 emsdk(上游仓库自带的 Makefile 的架构白名单里没有 wasm 项,所以直接调 `em++`)。

```bash
git clone https://github.com/skystarspython/Pikafish-HCE ~/wasm/hce
sh engine/build/build_wasm.sh ~/wasm/hce
```

脚本会把 `utils.h`、`preamble.js` 拷进源码树、跑 4 个补丁、编译 18 个 `.cpp`、链接,
最后把 `pikafish-hce.js` 和 `pikafish-hce.wasm` 拷回 `engine/`。emsdk 位置取 `$EMSDK`,
默认 `~/wasm/emsdk`。

目标文件有缓存,但判定会比对所有 `.h` 和 `.cpp` 的时间戳 —— 改过 `thread.h`
之后必须重编,只比 `.cpp` 会漏(踩过一次)。
