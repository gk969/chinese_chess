/**
 * 中文记谱(炮二平五 / 前马进七)。
 *
 * 线路号从各自一方右手边数起,所以红方一路在屏幕最右(f=8)、黑方 1 路在最左(f=0)
 * —— 和 render.js 画在棋盘上下两侧的坐标是同一套编号。
 */

const CN_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

const cnFile = (side, f) => (side === RED ? CN_DIGITS[9 - f] : String(f + 1));
const cnStep = (side, n) => (side === RED ? CN_DIGITS[n] : String(n));

/** 马象士斜走,落点只能用线路表示(步数永远是 2,写了也没信息量)。 */
const DIAGONAL_PIECES = [T_ADVISOR, T_ELEPHANT, T_HORSE];

/**
 * 歧义按竞赛规则是**位置性**的:同一种子有两只以上落在同一条竖线上,线路号就分不开了,
 * 一律改用前/后(三只则前/中/后)。不同线路的写法本身带线路号,天然不歧义。
 *
 * 必须在 board.make(m) 之前调用 —— 它看的是"走之前"盘面。
 */
function notate(board, m) {
  const v = board.at(m.f, m.r);
  if (v === EMPTY) return '';
  const side = sideOf(v);
  const type = typeOf(v);
  const name = PIECE_CHARS[side][type];

  // 越靠近对方阵营越"前":红方 r 小为前,黑方相反。
  const sameFile = [];
  for (let r = 0; r < ROWS; r++) {
    const u = board.at(m.f, r);
    if (u !== EMPTY && sideOf(u) === side && typeOf(u) === type) sameFile.push(r);
  }
  let prefix = '';
  if (sameFile.length >= 2) {
    sameFile.sort((a, b) => (side === RED ? a - b : b - a));
    const i = sameFile.indexOf(m.r);
    prefix = sameFile.length === 2 ? (i === 0 ? '前' : '后') : i === 0 ? '前' : i === sameFile.length - 1 ? '后' : '中';
  }

  // 没有前/后时,线路号跟在兵种后面标出起点(炮**二**平五);有了前/后就不再标线路。
  const who = prefix ? prefix + name : name + cnFile(side, m.f);

  if (m.r === m.tr) return who + '平' + cnFile(side, m.tf);

  const forward = side === RED ? m.tr < m.r : m.tr > m.r;
  const tail = DIAGONAL_PIECES.includes(type)
    ? cnFile(side, m.tf)
    : cnStep(side, Math.abs(m.tr - m.r));
  return who + (forward ? '进' : '退') + tail;
}
