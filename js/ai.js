/**
 * engine.js 的薄封装。main.js 只跟这个对象打交道,它保证同时只有一局搜索在跑 ——
 * 悔棋、重开、换难度都会先 cancel 掉上一局,回调解包时再核对令牌(见 main.js)。
 */
const AI = {
  current: null,

  think(board, level, onDone) {
    this.stop();
    const { current, done } = Engine.think(board, level);
    this.current = current;
    done.then((res) => {
      if (this.current === current) this.current = null;
      if (!res) return; // 被 cancel 掉了
      onDone(res);
    }).catch((e) => {
      if (this.current === current) this.current = null;
      onDone({ move: null, error: (e && e.message) || String(e) });
    });
    return current;
  },

  stop() {
    if (!this.current) return;
    this.current.cancel();
    this.current = null;
  },

  get busy() {
    return !!this.current;
  },
};
