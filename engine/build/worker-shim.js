/* Worker 侧的胶水。make_worker.sh 把它和 emscripten 的 glue 源码拼成同一个文件,
   主线程拿这个文件的内容做成 blob: URL 起 Worker。

   为什么非得拼成一个文件:file:// 下 Chrome 既不让 new Worker('engine/xxx.js')
   (origin 是 'null'),blob Worker 里也不让 importScripts 一个 file:// 脚本。
   两条都实测过,能起的只有"源码已经在页面上"的那种。 */
(() => {
  let sf = null;

  self.onmessage = async (e) => {
    const m = e.data || {};

    if (m.b64) {
      const s = atob(m.b64);
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
      try {
        sf = await PikafishHCE({
          instantiateWasm: (imports, receiveInstance) =>
            WebAssembly.compile(bytes)
              .then((mod) => new WebAssembly.Instance(mod, imports))
              .then(receiveInstance),
        });
        sf.addMessageListener((line) => postMessage({ out: typeof line === 'string' ? line : String(line) }));
        postMessage({ started: true });
      } catch (err) {
        postMessage({ fatal: String((err && err.message) || err) });
      }
      return;
    }

    // 这是 preamble.js 定义的 stdin 队列,跟 Worker 全局的 postMessage 没关系。
    if (sf) sf.postMessage(m.cmd);
  };
})();
