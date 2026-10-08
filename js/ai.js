/**
 * search.js 的薄封装。main.js 只跟这个对象打交道,它保证同时只有一局搜索在跑 ——
 * 悔棋、重开、换难度都会先 cancel 掉上一局,回调解包时再核对令牌(见 main.js)。
 */
const AI = {
  current: null,

  think(board, level, onDone) {
    this.stop();
    const s = new Search(board, PROFILES[level] || PROFILES.mid);
    this.current = s;
    s.start((res) => {
      if (this.current === s) this.current = null;
      onDone(res);
    });
    return s;
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
