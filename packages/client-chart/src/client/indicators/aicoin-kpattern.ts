/**
 * AiCoin「K线形态」脚本 1:1 移植（用户提供的 // @version=2 源码）+ 百度股市通 / TradingCentral 24 种 K 线与经典形态目录扩展。
 *
 * - 15 个 AiCoin plotText：条件、title、text、color、refSeries、placement 与源码逐条一致（KP_PLOTS 顺序 = 源码 plotText 顺序）。
 * - 19 个百度股市通扩展形态（KP_BAIDU_PLOTS）：与 5 个复用 AiCoin 的形态合集组成完整的 24 项 KP_BAIDU_CATALOG（type 70..123）。
 * - 15 个 alertcondition：title / direction 与源码一致（KP_ALERTS 顺序 = 源码 alertcondition 顺序）。
 * - 源码里的常数（0.005 振幅、0.000015 平头容差、factor 0.24、0.003 波动、5/10 根回看）是硬编码，不是 input，所以不做成参数。
 * - plotText 未传 bgColor / fontSize：按 AiCoin 文档默认 bgColor=rgba(255,255,255,1)、fontSize=14。
 *   color 'green' / 'red' 为常用颜色名，按 CSS 取 #008000 / #ff0000。关闭「跟随主题配色」即为这套源码配色。
 * - 插件适配（AiCoin 没有的）：跟随图表主题涨跌色、标签碰撞避让（完整→简写→三角）、未收盘 K 线半透明、showLast、百度扩展形态独立开关。
 * - highest/lowest 回看窗口不足（K 线历史开头几根）视为 nan，比较结果为 false。
 */
export interface KpCandle { open: number; high: number; low: number; close: number }

export const KP_PLOTS = [
  { key: 'hammer', title: '锤子线', text: '锤子线', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'hangingMan', title: '上吊线', text: '上吊线', color: 'red', ref: 'high', placement: 'top' },
  { key: 'shootingStar', title: '流星线', text: '流星线', color: 'red', ref: 'high', placement: 'top' },
  { key: 'darkCloudCover', title: '乌云盖顶', text: '乌云盖顶', color: 'red', ref: 'high', placement: 'top' },
  { key: 'piercingLine', title: '刺透', text: '刺透', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'dojiTop', title: '平头顶', text: '平头顶', color: 'red', ref: 'high', placement: 'top' },
  { key: 'dojiBottom', title: '平头底', text: '平头底', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'bullishEngulfing', title: '看涨吞没', text: '涨吞没', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'bearishEngulfing', title: '看跌吞没', text: '跌吞没', color: 'red', ref: 'high', placement: 'top' },
  { key: 'morningStar', title: '启明星', text: '启明星', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'eveningStar', title: '黄昏星', text: '黄昏星', color: 'red', ref: 'high', placement: 'top' },
  { key: 'redThreeSoldiers', title: '红三兵', text: '红三兵', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'blackThreeSoldiers', title: '黑三兵', text: '黑三兵', color: 'red', ref: 'high', placement: 'top' },
  { key: 'topFormation', title: '顶分型', text: '顶分型', color: 'red', ref: 'high', placement: 'top' },
  { key: 'bottomFormation', title: '底分型', text: '底分型', color: 'green', ref: 'low', placement: 'bottom' },
] as const

export const KP_BAIDU_PLOTS = [
  { key: 'roundingTop', type: 70, title: '圆弧顶', text: '圆弧顶', short: '弧顶', color: 'red', ref: 'high', placement: 'top' },
  { key: 'roundingBottom', type: 71, title: '圆弧底', text: '圆弧底', short: '弧底', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'gapUp', type: 101, title: '跳空上涨', text: '跳空涨', short: '跳涨', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'gapDown', type: 102, title: '跳空下跌', text: '跳空跌', short: '跳跌', color: 'red', ref: 'high', placement: 'top' },
  { key: 'islandTop', type: 103, title: '岛形顶部', text: '岛形顶', short: '岛顶', color: 'red', ref: 'high', placement: 'top' },
  { key: 'islandBottom', type: 104, title: '岛形底部', text: '岛形底', short: '岛底', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'gravestoneBull', type: 110, title: '墓碑线(看涨)', text: '墓碑涨', short: '墓涨', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'invertedHammer', type: 112, title: '倒锤线', text: '倒锤线', short: '倒锤', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'outsideBull', type: 113, title: '覆盖线(看涨)', text: '覆盖涨', short: '覆涨', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'outsideBear', type: 114, title: '覆盖线(看跌)', text: '覆盖跌', short: '覆跌', color: 'red', ref: 'high', placement: 'top' },
  { key: 'haramiBull', type: 115, title: '被覆盖线(看涨)', text: '孕线涨', short: '孕涨', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'haramiBear', type: 116, title: '被覆盖线(看跌)', text: '孕线跌', short: '孕跌', color: 'red', ref: 'high', placement: 'top' },
  { key: 'keyRevBear', type: 117, title: '关键反转线(看跌)', text: '关键反跌', short: '关跌', color: 'red', ref: 'high', placement: 'top' },
  { key: 'keyRevBull', type: 118, title: '关键反转线(看涨)', text: '关键反涨', short: '关涨', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'exhaustionBear', type: 119, title: '衰竭线(看跌)', text: '衰竭跌', short: '衰跌', color: 'red', ref: 'high', placement: 'top' },
  { key: 'exhaustionBull', type: 120, title: '衰竭线(看涨)', text: '衰竭涨', short: '衰涨', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'twoBarRevBull', type: 121, title: '两线反转(看涨)', text: '两线反涨', short: '两涨', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'twoBarRevBear', type: 122, title: '两线反转(看跌)', text: '两线反跌', short: '两跌', color: 'red', ref: 'high', placement: 'top' },
  { key: 'gravestoneBear', type: 123, title: '墓碑线(看跌)', text: '墓碑跌', short: '墓跌', color: 'red', ref: 'high', placement: 'top' },
] as const

export type KpKey = typeof KP_PLOTS[number]['key']
export type KpBaiduKey = typeof KP_BAIDU_PLOTS[number]['key']
export type KpRow = Record<KpKey | KpBaiduKey, boolean>

export interface KpBaiduCatalogItem {
  type: number
  title: string
  key: KpKey | KpBaiduKey
  direction: 'bull' | 'bear'
  meaning: string
  description: string
}

/** 百度股市通 / TradingCentral AI 技术事件 24 项形态目录（按 type id 升序）。 */
export const KP_BAIDU_CATALOG: readonly KpBaiduCatalogItem[] = [
  {
    type: 70,
    title: '圆弧顶',
    key: 'roundingTop',
    direction: 'bear',
    meaning: '看跌反转形态，买方力量逐步衰减、卖方力量渐占上风。',
    description: '价格在上涨后涨势放缓并呈现圆弧状顶部，近期高点逐级下移且收盘跌破短期均线，预示趋势由涨转跌。',
  },
  {
    type: 71,
    title: '圆弧底',
    key: 'roundingBottom',
    direction: 'bull',
    meaning: '看涨反转形态，卖盘压力逐步耗尽、买盘稳步承接。',
    description: '价格在下跌后跌势趋缓并构筑碗状底部，近期低点逐级抬升且收盘突破短期均线，预示趋势由跌转涨。',
  },
  {
    type: 101,
    title: '跳空上涨',
    key: 'gapUp',
    direction: 'bull',
    meaning: '看涨持续或突破信号，买盘积极推高价格形成向上缺口。',
    description: '当前K线最低价显著高于前一根K线最高价，留下未回补的向上跳空缺口，显示多头动能强劲。',
  },
  {
    type: 102,
    title: '跳空下跌',
    key: 'gapDown',
    direction: 'bear',
    meaning: '看跌持续或破位信号，卖盘集中涌出形成向下缺口。',
    description: '当前K线最高价显著低于前一根K线最低价，留下未回补的向下跳空缺口，显示空头动能占优。',
  },
  {
    type: 103,
    title: '岛形顶部',
    key: 'islandTop',
    direction: 'bear',
    meaning: '强烈看跌反转形态，高位追多筹码被前后双向缺口孤立。',
    description: '前期向上跳空后在顶部停留1至5根K线，随后当前K线向下跳空且最高价低于岛区最低价，构成孤岛反转。',
  },
  {
    type: 104,
    title: '岛形底部',
    key: 'islandBottom',
    direction: 'bull',
    meaning: '强烈看涨反转形态，低位恐慌盘被前后双向缺口孤立。',
    description: '前期向下跳空后在底部停留1至5根K线，随后当前K线向上跳空且最低价高于岛区最高价，构成底部孤岛反转。',
  },
  {
    type: 106,
    title: '射击之星',
    key: 'shootingStar',
    direction: 'bear',
    meaning: '看跌反转信号，高位冲高回落表明上方抛压沉重。',
    description: '出现在上涨末端创阶段新高，上影线长度至少为实体的2倍、下影线极短，反映多头上攻受阻。',
  },
  {
    type: 107,
    title: '吊人形态',
    key: 'hangingMan',
    direction: 'bear',
    meaning: '高位看跌警示信号，盘中大幅下探显示多头控盘松动。',
    description: '出现在上涨趋势高位附近，实体较小且位于K线上端，下影线至少为实体2倍，警示卖压开始涌现。',
  },
  {
    type: 108,
    title: '吞没线（看涨）',
    key: 'bullishEngulfing',
    direction: 'bull',
    meaning: '看涨反转形态，多头反攻完全吞没前一日空头实体。',
    description: '前一根为阴线，当前阳线低开高走且实体完全包络前一根阴线实体并创出更低点，显示买盘强力扭转跌势。',
  },
  {
    type: 109,
    title: '吞没线（看跌）',
    key: 'bearishEngulfing',
    direction: 'bear',
    meaning: '看跌反转形态，空头反扑完全吞没前一日多头实体。',
    description: '前一根为阳线，当前阴线高开低走且实体完全包络前一根阳线实体并创出更高点，显示卖盘强力终结涨势。',
  },
  {
    type: 110,
    title: '墓碑线（看涨）',
    key: 'gravestoneBull',
    direction: 'bull',
    meaning: '下跌末端的试盘反转信号，多头尝试向上测试上方阻力。',
    description: '出现在下跌趋势新低处，开盘与收盘均接近最低价，留有极长上影线与极小实体，提示空头动能衰竭。',
  },
  {
    type: 111,
    title: '锤形线',
    key: 'hammer',
    direction: 'bull',
    meaning: '底部看涨反转信号，低位长下影线表明下方买盘承接有力。',
    description: '出现在下跌趋势阶段新低，下影线长度至少为实体的2倍且上影线极短，显示空头打压后被多头拉回。',
  },
  {
    type: 112,
    title: '倒锤线',
    key: 'invertedHammer',
    direction: 'bull',
    meaning: '底部看涨反转信号，低位向上试盘预示反弹即将展开。',
    description: '出现在下跌趋势阶段新低，上影线至少为实体的2倍、下影线极短且实体处于底部，显示买方开始主动试探。',
  },
  {
    type: 113,
    title: '覆盖线（看涨）',
    key: 'outsideBull',
    direction: 'bull',
    meaning: '看涨外包反转信号，波动区间扩张且多头完全主导收盘。',
    description: '下跌趋势后出现阳线，其最高价高于前一根最高价且最低价低于前一根最低价，全振幅包络前线并收涨。',
  },
  {
    type: 114,
    title: '覆盖线（看跌）',
    key: 'outsideBear',
    direction: 'bear',
    meaning: '看跌外包反转信号，波动区间扩张且空头完全主导收盘。',
    description: '上涨趋势后出现阴线，其最高价高于前一根最高价且最低价低于前一根最低价，全振幅包络前线并收跌。',
  },
  {
    type: 115,
    title: '被覆盖线（看涨）',
    key: 'haramiBull',
    direction: 'bull',
    meaning: '看涨孕线形态，下跌动能收缩、空头攻势停滞。',
    description: '下跌趋势中大阴线之后，当前小阳线的最高价与最低价完全处于前一根阴线高低点之内，孕育底部反转。',
  },
  {
    type: 116,
    title: '被覆盖线（看跌）',
    key: 'haramiBear',
    direction: 'bear',
    meaning: '看跌孕线形态，上涨动能收缩、多头攻势受阻。',
    description: '上涨趋势中大阳线之后，当前小阴线的最高价与最低价完全处于前一根阳线高低点之内，孕育顶部反转。',
  },
  {
    type: 117,
    title: '关键反转线（看跌）',
    key: 'keyRevBear',
    direction: 'bear',
    meaning: '强烈看跌关键日反转，新高诱多后迅速杀跌破位。',
    description: '上涨趋势中跳空高开高于前高并创10根新高，随后大幅回落且收盘跌破前一根收盘价与最低价。',
  },
  {
    type: 118,
    title: '关键反转线（看涨）',
    key: 'keyRevBull',
    direction: 'bull',
    meaning: '强烈看涨关键日反转，新低诱空后强力逼空拉升。',
    description: '下跌趋势中跳空低开低于前低并创10根新低，随后大幅拉升且收盘突破前一根收盘价与最高价。',
  },
  {
    type: 119,
    title: '衰竭线（看跌）',
    key: 'exhaustionBear',
    direction: 'bear',
    meaning: '上涨动能耗尽信号，最后的跳空冲高遭遇空头猛烈反击。',
    description: '急涨创新高后当前K线跳空高开，但卖方迅速主导盘面使K线收阴且收盘位于全天振幅底部25%以内。',
  },
  {
    type: 120,
    title: '衰竭线（看涨）',
    key: 'exhaustionBull',
    direction: 'bull',
    meaning: '下跌动能耗尽信号，最后的跳空杀跌引发抄底资金涌入。',
    description: '急跌创新低后当前K线跳空低开，但买方迅速主导盘面使K线收阳且收盘位于全天振幅顶部25%以内。',
  },
  {
    type: 121,
    title: '两线反转（看涨）',
    key: 'twoBarRevBull',
    direction: 'bull',
    meaning: '双K线看涨V型反转，前日极弱杀跌被次日极强拉升完全收复。',
    description: '下跌趋势中前一根长阴线接近最低价收盘，当前长阳线接近最高价收盘且收盘价高于前一根开盘价。',
  },
  {
    type: 122,
    title: '两线反转（看跌）',
    key: 'twoBarRevBear',
    direction: 'bear',
    meaning: '双K线看跌倒V反转，前日极强拉升被次日极弱杀跌完全抹去。',
    description: '上涨趋势中前一根长阳线接近最高价收盘，当前长阴线接近最低价收盘且收盘价低于前一根开盘价。',
  },
  {
    type: 123,
    title: '墓碑线（看跌）',
    key: 'gravestoneBear',
    direction: 'bear',
    meaning: '顶部看跌反转信号，高位冲高回落至开盘价附近形成墓碑形态。',
    description: '出现在上涨趋势10根新高处，上影线占振幅65%以上而实体与下影线均极小，表明上方抛压极重。',
  },
] as const

/** alertcondition(…) 源码顺序。 */
export const KP_ALERTS: readonly { key: KpKey; title: string; direction: 'buy' | 'sell' }[] = [
  { key: 'hammer', title: '锤子线', direction: 'buy' },
  { key: 'hangingMan', title: '上吊线', direction: 'sell' },
  { key: 'shootingStar', title: '流星线', direction: 'sell' },
  { key: 'bullishEngulfing', title: '看涨吞没', direction: 'buy' },
  { key: 'bearishEngulfing', title: '看跌吞没', direction: 'sell' },
  { key: 'darkCloudCover', title: '乌云盖顶', direction: 'sell' },
  { key: 'piercingLine', title: '刺透形态', direction: 'buy' },
  { key: 'morningStar', title: '启明星', direction: 'buy' },
  { key: 'eveningStar', title: '黄昏星', direction: 'sell' },
  { key: 'dojiTop', title: '平头顶', direction: 'sell' },
  { key: 'dojiBottom', title: '平头底', direction: 'buy' },
  { key: 'topFormation', title: '顶分型', direction: 'sell' },
  { key: 'bottomFormation', title: '底分型', direction: 'buy' },
  { key: 'redThreeSoldiers', title: '红三兵', direction: 'buy' },
  { key: 'blackThreeSoldiers', title: '黑三兵', direction: 'sell' },
]

/** CSS 颜色名 → 0xRRGGBB（AiCoin「常用颜色」）。 */
export const KP_NAMED_COLOR = { green: 0x008000, red: 0xff0000 } as const

export const KP_N = KP_PLOTS.length
export const KP_BAIDU_N = KP_BAIDU_PLOTS.length
/** plotText placement bottom = 看涨（绿色、画在低点下方），top = 看跌。 */
export const kpIsBull = (n: number): boolean =>
  n < KP_N ? KP_PLOTS[n]!.placement === 'bottom' : KP_BAIDU_PLOTS[n - KP_N]!.placement === 'bottom'
export const KP_BULL_INDICES: readonly number[] = KP_PLOTS.map((_, n) => n).filter(kpIsBull)
export const KP_BEAR_INDICES: readonly number[] = KP_PLOTS.map((_, n) => n).filter(n => !kpIsBull(n))
export const KP_BAIDU_BULL_INDICES: readonly number[] = KP_BAIDU_PLOTS.map((_, n) => n).filter(n => KP_BAIDU_PLOTS[n]!.placement === 'bottom')
export const KP_BAIDU_BEAR_INDICES: readonly number[] = KP_BAIDU_PLOTS.map((_, n) => n).filter(n => KP_BAIDU_PLOTS[n]!.placement === 'top')

/** 插件「简写」标签：K 线间距不够放完整文字时用。 */
export const KP_SHORT: Record<KpKey | KpBaiduKey, string> = {
  hammer: '锤子', hangingMan: '上吊', shootingStar: '流星', darkCloudCover: '乌云', piercingLine: '刺透',
  dojiTop: '平顶', dojiBottom: '平底', bullishEngulfing: '涨吞', bearishEngulfing: '跌吞', morningStar: '启明',
  eveningStar: '黄昏', redThreeSoldiers: '红三', blackThreeSoldiers: '黑三', topFormation: '顶分', bottomFormation: '底分',
  roundingTop: '弧顶', roundingBottom: '弧底', gapUp: '跳涨', gapDown: '跳跌', islandTop: '岛顶', islandBottom: '岛底',
  gravestoneBull: '墓涨', invertedHammer: '倒锤', outsideBull: '覆涨', outsideBear: '覆跌', haramiBull: '孕涨',
  haramiBear: '孕跌', keyRevBear: '关跌', keyRevBull: '关涨', exhaustionBear: '衰跌', exhaustionBull: '衰涨',
  twoBarRevBull: '两涨', twoBarRevBear: '两跌', gravestoneBear: '墓跌',
}

/**
 * 参数槽位
 *   1:1 源码段  [0,15) 显示  [15,30) 颜色  30 字号  31 文字背景  32 背景色  [33,48) 提醒（alertcondition 顺序）
 *   插件段      48 跟随主题配色  49 标签模式  50 未收盘K线标注  51 只显示最近N根(=plotText showLast, 0 全部)
 *   百度扩展段  [52,71) 19 个百度股市通扩展形态开关（0/1）
 * 插件段与百度扩展段追加在末尾，已保存的设置下标不变。
 */
export const KP_SHOW = 0
export const KP_COLOR = KP_N
export const KP_FONT = 2 * KP_N
export const KP_BG_ON = KP_FONT + 1
export const KP_BG_COLOR = KP_FONT + 2
export const KP_ALERT = KP_FONT + 3
export const KP_THEME = KP_ALERT + KP_ALERTS.length
export const KP_MODE = KP_THEME + 1
export const KP_FORMING = KP_THEME + 2
export const KP_LAST = KP_THEME + 3
export const KP_BAIDU_SHOW = KP_THEME + 4

export const KP_LABEL_MODES = ['自动避让', '完整文字', '简写', '仅标记'] as const

export const KP_DEFAULTS: readonly number[] = [
  ...KP_PLOTS.map(() => 1),
  ...KP_PLOTS.map(p => KP_NAMED_COLOR[p.color]),
  12, 1, 0xffffff,
  ...KP_ALERTS.map(() => 0),
  1, 0, 1, 0,
  ...KP_BAIDU_PLOTS.map(() => 1),
]

export interface KpParams {
  show: boolean[]
  color: number[]
  fontSize: number
  bgOn: boolean
  bgColor: number
  /** Indexed like KP_ALERTS. */
  alertOn: boolean[]
  /** 用图表主题的涨跌色（有主题信息时）；关闭 = 源码颜色 + 自定义颜色。 */
  theme: boolean
  /** 0 自动避让  1 完整文字  2 简写  3 仅标记 */
  mode: number
  forming: boolean
  showLast: number
  /** Indexed like KP_BAIDU_PLOTS (slots 52..70). */
  baiduShow: boolean[]
}

export function sanitizeKPatternParams(raw?: readonly unknown[]): KpParams {
  const params = Array.isArray(raw) ? raw : []
  const legacy52 = params.length > 0 && params.length <= KP_BAIDU_SHOW
  const num = (i: number): number => {
    const v = params[i]
    return typeof v === 'number' && Number.isFinite(v) ? v : KP_DEFAULTS[i]!
  }
  const baiduNum = (j: number): number => {
    const i = KP_BAIDU_SHOW + j
    const v = params[i]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    return legacy52 ? 0 : KP_DEFAULTS[i]!
  }
  const color = (i: number): number => Math.max(0, Math.min(0xffffff, Math.round(num(i))))
  return {
    show: KP_PLOTS.map((_, k) => num(KP_SHOW + k) === 1),
    color: KP_PLOTS.map((_, k) => color(KP_COLOR + k)),
    fontSize: Math.max(6, Math.min(40, Math.round(num(KP_FONT)))),
    bgOn: num(KP_BG_ON) === 1,
    bgColor: color(KP_BG_COLOR),
    alertOn: KP_ALERTS.map((_, k) => num(KP_ALERT + k) === 1),
    theme: num(KP_THEME) === 1,
    mode: Math.max(0, Math.min(KP_LABEL_MODES.length - 1, Math.round(num(KP_MODE)))),
    forming: num(KP_FORMING) === 1,
    showLast: Math.max(0, Math.round(num(KP_LAST))),
    baiduShow: KP_BAIDU_PLOTS.map((_, j) => baiduNum(j) === 1),
  }
}

export const sanitizeKpParams = sanitizeKPatternParams

/** 逐根计算 15 个 AiCoin 形态 + 19 个百度股市通扩展形态条件；越界的历史值为 nan（比较一律 false）。 */
export function calculateKPatterns(c: readonly KpCandle[]): KpRow[] {
  const O = (i: number): number => (i >= 0 && i < c.length ? c[i]!.open : NaN)
  const H = (i: number): number => (i >= 0 && i < c.length ? c[i]!.high : NaN)
  const L = (i: number): number => (i >= 0 && i < c.length ? c[i]!.low : NaN)
  const C = (i: number): number => (i >= 0 && i < c.length ? c[i]!.close : NaN)
  /** highest(src[off], len) at bar i = max(src[i-off-len+1 .. i-off]); window not available → nan. */
  const highest = (src: (i: number) => number, off: number, len: number, i: number): number => {
    const start = i - off - len + 1
    if (start < 0) return NaN
    let m = -Infinity
    for (let j = start; j <= i - off; j++) m = Math.max(m, src(j))
    return m
  }
  const lowest = (src: (i: number) => number, off: number, len: number, i: number): number => {
    const start = i - off - len + 1
    if (start < 0) return NaN
    let m = Infinity
    for (let j = start; j <= i - off; j++) m = Math.min(m, src(j))
    return m
  }
  const wave = (k: number): number => Math.abs(C(k) - O(k)) / O(k)
  const change = (k: number): number => C(k) - O(k)
  const factor = 0.24

  return c.map((_, i) => {
    const open = O(i); const high = H(i); const low = L(i); const close = C(i)
    const HighestHigh = H(i - 1) > highest(H, 2, 5, i)
    const lowestLow = L(i - 1) < lowest(L, 2, 5, i)
    const ampl = (high - low) / C(i - 1)
    const solid = Math.abs(close - open)
    const overshadow = high - Math.max(open, close)
    const undershadow = Math.min(close, open) - low
    const range = high - low
    const range1 = H(i - 1) - L(i - 1)

    const hammer = undershadow >= 2 * Math.abs(close - open) && ampl > 0.005 && low < lowest(L, 1, 10, i) && overshadow < 0.5 * solid
    const hangingMan = undershadow >= 2 * Math.abs(close - open) && ampl > 0.005 && H(i - 1) > highest(H, 2, 10, i) && overshadow < 0.5 * solid
    const shootingStar = overshadow >= 2 * Math.abs(close - open) && ampl > 0.005 && high > highest(H, 1, 10, i) && undershadow < 0.5 * solid
    const darkCloudCover = O(i - 1) < C(i - 1) && open > close && open > C(i - 1) && close > O(i - 1) && close < (O(i - 1) + C(i - 1)) / 2 && HighestHigh
    const piercingLine = O(i - 1) > C(i - 1) && open < close && open < C(i - 1) && close < O(i - 1) && close > (O(i - 1) + C(i - 1)) / 2 && lowestLow
    const dojiTop = Math.abs(high - H(i - 1)) / H(i - 1) <= 0.000015 && HighestHigh
    const dojiBottom = Math.abs(low - L(i - 1)) / L(i - 1) <= 0.000015 && lowestLow
    const bullishEngulfing = O(i - 1) > C(i - 1) && close > open && close > O(i - 1) && open < C(i - 1) && wave(i) > 0.005 && low < L(i - 1)
    const bearishEngulfing = O(i - 1) < C(i - 1) && close < open && close < O(i - 1) && open > C(i - 1) && wave(i) > 0.005 && high > H(i - 1)

    let morningStar = false
    let eveningStar = false
    if (Math.abs(change(i - 1)) < factor * Math.min(Math.abs(change(i)), Math.abs(change(i - 2)))) {
      if (change(i - 2) < 0 && change(i) > 0) {
        if (close > C(i - 2) && H(i - 1) < Math.min(close, O(i - 2)) && L(i - 1) < Math.min(low, L(i - 2)) && lowestLow) morningStar = true
      } else if (change(i - 2) > 0 && change(i) < 0) {
        if (close < C(i - 2) && H(i - 1) > Math.max(H(i - 2), high) && L(i - 1) > Math.max(close, O(i - 2)) && HighestHigh) eveningStar = true
      }
    }

    const redThreeSoldiers = close > open && C(i - 1) > O(i - 1) && C(i - 2) > O(i - 2) && close > C(i - 1) && C(i - 1) > C(i - 2) && wave(i - 2) > 0.003 && wave(i - 1) > 0.003 && wave(i) > 0.003
    const blackThreeSoldiers = close < open && C(i - 1) < O(i - 1) && C(i - 2) < O(i - 2) && close < C(i - 1) && C(i - 1) < C(i - 2) && wave(i - 2) > 0.003 && wave(i - 1) > 0.003 && wave(i) > 0.003
    const topFormation = H(i - 1) > H(i - 2) && H(i - 1) > high && H(i - 1) > highest(H, 2, 10, i) && close < C(i - 1) && O(i - 1) > O(i - 2) && L(i - 2) < L(i - 1) && L(i - 1) > low
    const bottomFormation = L(i - 1) < L(i - 2) && L(i - 1) < low && L(i - 1) < lowest(L, 2, 10, i) && close > H(i - 1) && H(i - 2) > H(i - 1) && high > H(i - 1)

    // Baidu Finance / TradingCentral 19 additional patterns
    const ma5 = i >= 4 ? (C(i - 4) + C(i - 3) + C(i - 2) + C(i - 1) + close) / 5 : NaN
    const roundingTop =
      i >= 9 &&
      highest(H, 3, 4, i) > highest(H, 7, 3, i) &&
      highest(H, 3, 4, i) > highest(H, 0, 3, i) &&
      H(i - 2) > H(i - 1) &&
      H(i - 1) > high &&
      highest(C, 3, 4, i) > C(i - 9) &&
      close < ma5 &&
      close < C(i - 1)
    const roundingBottom =
      i >= 9 &&
      lowest(L, 3, 4, i) < lowest(L, 7, 3, i) &&
      lowest(L, 3, 4, i) < lowest(L, 0, 3, i) &&
      L(i - 2) < L(i - 1) &&
      L(i - 1) < low &&
      lowest(C, 3, 4, i) < C(i - 9) &&
      close > ma5 &&
      close > C(i - 1)

    const gapUp = low > H(i - 1) * 1.001
    const gapDown = high < L(i - 1) * 0.999

    let islandTop = false
    let islandBottom = false
    for (let k = 1; k <= 5; k++) {
      if (i - k - 1 < 0) break
      const islandLow = lowest(L, 1, k, i)
      if (L(i - k) > H(i - k - 1) * 1.001 && islandLow > H(i - k - 1) && high < islandLow) {
        islandTop = true
      }
      const islandHigh = highest(H, 1, k, i)
      if (H(i - k) < L(i - k - 1) * 0.999 && islandHigh < L(i - k - 1) && low > islandHigh) {
        islandBottom = true
      }
    }

    const gravestoneBull =
      low < lowest(L, 1, 10, i) &&
      range > 0 &&
      overshadow >= 0.65 * range &&
      solid <= 0.15 * range &&
      undershadow <= 0.15 * range &&
      ampl > 0.005
    const invertedHammer =
      low < lowest(L, 1, 10, i) &&
      overshadow >= 2 * solid &&
      solid > 0 &&
      undershadow < 0.5 * solid &&
      ampl > 0.005
    const outsideBull =
      close > open &&
      lowestLow &&
      high > H(i - 1) &&
      low < L(i - 1) &&
      wave(i) > 0.005
    const outsideBear =
      close < open &&
      HighestHigh &&
      high > H(i - 1) &&
      low < L(i - 1) &&
      wave(i) > 0.005
    const haramiBull =
      lowestLow &&
      C(i - 1) < O(i - 1) &&
      wave(i - 1) > 0.005 &&
      close > open &&
      high < H(i - 1) &&
      low > L(i - 1) &&
      solid > 0
    const haramiBear =
      HighestHigh &&
      C(i - 1) > O(i - 1) &&
      wave(i - 1) > 0.005 &&
      close < open &&
      high < H(i - 1) &&
      low > L(i - 1) &&
      solid > 0
    const keyRevBear =
      high > highest(H, 1, 10, i) &&
      C(i - 1) > O(i - 1) &&
      open > H(i - 1) &&
      close < C(i - 1) &&
      close < L(i - 1)
    const keyRevBull =
      low < lowest(L, 1, 10, i) &&
      C(i - 1) < O(i - 1) &&
      open < L(i - 1) &&
      close > C(i - 1) &&
      close > H(i - 1)
    const exhaustionBear =
      C(i - 1) > O(i - 1) &&
      wave(i - 1) > 0.005 &&
      HighestHigh &&
      open > H(i - 1) &&
      close < open &&
      close - low <= 0.25 * range &&
      wave(i) > 0.005
    const exhaustionBull =
      C(i - 1) < O(i - 1) &&
      wave(i - 1) > 0.005 &&
      lowestLow &&
      open < L(i - 1) &&
      close > open &&
      high - close <= 0.25 * range &&
      wave(i) > 0.005
    const twoBarRevBull =
      lowestLow &&
      C(i - 1) < O(i - 1) &&
      C(i - 1) - L(i - 1) <= 0.2 * range1 &&
      wave(i - 1) > 0.005 &&
      close > open &&
      high - close <= 0.2 * range &&
      close > O(i - 1) &&
      wave(i) > 0.005
    const twoBarRevBear =
      HighestHigh &&
      C(i - 1) > O(i - 1) &&
      H(i - 1) - C(i - 1) <= 0.2 * range1 &&
      wave(i - 1) > 0.005 &&
      close < open &&
      close - low <= 0.2 * range &&
      close < O(i - 1) &&
      wave(i) > 0.005
    const gravestoneBear =
      high > highest(H, 1, 10, i) &&
      range > 0 &&
      overshadow >= 0.65 * range &&
      solid <= 0.15 * range &&
      undershadow <= 0.15 * range &&
      ampl > 0.005

    return {
      hammer, hangingMan, shootingStar, darkCloudCover, piercingLine, dojiTop, dojiBottom,
      bullishEngulfing, bearishEngulfing, morningStar, eveningStar, redThreeSoldiers, blackThreeSoldiers,
      topFormation, bottomFormation,
      roundingTop, roundingBottom, gapUp, gapDown, islandTop, islandBottom,
      gravestoneBull, invertedHammer, outsideBull, outsideBear, haramiBull, haramiBear,
      keyRevBear, keyRevBull, exhaustionBear, exhaustionBull, twoBarRevBull, twoBarRevBear, gravestoneBear,
    }
  })
}

/** 命中的 AiCoin 形态 key，按 plotText 顺序。 */
export const kpHits = (row: KpRow | undefined): KpKey[] => (row ? KP_PLOTS.filter(p => row[p.key]).map(p => p.key) : [])

/** 命中的百度股市通扩展形态 key（19 项），按 KP_BAIDU_PLOTS 顺序。 */
export const kpBaiduHits = (row: KpRow | undefined): KpBaiduKey[] =>
  row ? KP_BAIDU_PLOTS.filter(p => row[p.key]).map(p => p.key) : []

/** 命中的全部形态 key（先 15 项 AiCoin，后 19 项百度扩展）。 */
export const kpAllHits = (row: KpRow | undefined): (KpKey | KpBaiduKey)[] => [...kpHits(row), ...kpBaiduHits(row)]

/** 已开启提醒、在最近一根已收盘 K 线（倒数第二根）上触发的 alertcondition。 */
export function kpAlertEvents(candles: readonly (KpCandle & { time: string })[], params: readonly unknown[]): { id: string; text: string }[] {
  if (candles.length < 2) return []
  const P = sanitizeKpParams(params)
  if (!P.alertOn.some(Boolean)) return []
  const i = candles.length - 2
  const row = calculateKPatterns(candles)[i]
  if (!row) return []
  const t = candles[i]!.time
  return KP_ALERTS.filter((a, k) => P.alertOn[k] && row[a.key])
    .map(a => ({ id: t + '|kp.' + a.key, text: a.title + ' · ' + (a.direction === 'buy' ? '买入' : '卖出') + ' (' + t + ')' }))
}
export const kpHex = (n: number): string => '#' + Math.max(0, Math.min(0xffffff, Math.round(n))).toString(16).padStart(6, '0')

/** 图表主题（由 ChartCard 经 extendData 传入）：涨/跌色、标签底色，reserve = 预留给 TD 主图计数的像素。 */
export interface KpTheme { up: string; down: string; bg: string; reserve?: number }
export function asKpTheme(ext: unknown): KpTheme | undefined {
  const e = ext as Partial<KpTheme> | null | undefined
  return e && typeof e.up === 'string' && typeof e.down === 'string' && typeof e.bg === 'string' ? e as KpTheme : undefined
}
export const withAlpha = (hex: string, a: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')'
}

export interface KpLabelStyle { text: string; fill?: string; tint?: string; stroke?: string }
/** 主题模式：主题涨跌色的描边小标签；源码模式：plotText 的 color + bgColor。 */
export function kpStyle(P: KpParams, n: number, theme: KpTheme | undefined): KpLabelStyle {
  if (P.theme && theme) {
    const c = kpIsBull(n) ? theme.up : theme.down
    return { text: c }
  }
  const col = n < KP_N ? P.color[n]! : KP_NAMED_COLOR[KP_BAIDU_PLOTS[n - KP_N]!.color]
  return P.bgOn ? { text: kpHex(col), fill: kpHex(P.bgColor) } : { text: kpHex(col) }
}

const FONT_FAMILY = 'system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'
/** 文字框内边距 / 与 K 线的距离 / 堆叠间距（px）。 */
const PAD = 2
const GAP = 8
const STACK = 2
/** 自动避让：每种文字最多往外挪的层数，放不下就退到简写，再退到小三角。 */
const AUTO_SLOTS = 3
const FORCED_SLOTS = 8
const FORMING_ALPHA = 0.5

export function createKPatternTooltipDataSource({ indicator, crosshair }: {
  indicator: { calcParams: number[]; result: KpRow[]; extendData?: unknown }
  crosshair: { dataIndex?: number | undefined }
}) {
  const P = sanitizeKpParams(indicator.calcParams)
  const theme = asKpTheme(indicator.extendData)
  const i = crosshair.dataIndex
  const row = i !== undefined ? indicator.result?.[i] : undefined
  const values = [
    ...KP_PLOTS.flatMap((p, k) => (P.show[k] && row?.[p.key]
      ? [{ title: p.title + ': ', value: { text: p.text, color: kpStyle(P, k, theme).text } }]
      : [])),
    ...KP_BAIDU_PLOTS.flatMap((p, j) => (P.baiduShow[j] && row?.[p.key]
      ? [{ title: p.title + ': ', value: { text: p.text, color: kpStyle(P, KP_N + j, theme).text } }]
      : [])),
  ]
  return { name: 'K线形态', calcParamsText: '', values, icons: [] }
}

interface DrawArgs {
  ctx: CanvasRenderingContext2D
  indicator: { calcParams: number[]; result: KpRow[]; extendData?: unknown }
  xAxis: { convertToPixel: (val: number) => number }
  yAxis: { convertToPixel: (val: number) => number }
  visibleRange: { from: number; to: number }
  bounding?: { width: number; height: number }
  barSpace?: { bar?: number }
  kLineDataList: { high?: number; low?: number }[]
}

interface Rect { x0: number; x1: number; y0: number; y1: number }

/**
 * plotText 的插件渲染：top 画在 high 上方、bottom 画在 low 下方。
 * 与 AiCoin 不同的是这里做碰撞避让 —— 相邻 K 线的标签不叠在一起：
 * 自动模式依次尝试 完整文字 → 简写 → 小三角；最后一根（未收盘）K 线半透明，可关闭。
 */
export function drawKPatterns({ ctx, indicator, xAxis, yAxis, visibleRange, bounding, barSpace, kLineDataList }: DrawArgs): boolean {
  const rows = indicator.result
  if (!rows || rows.length === 0) return true
  const P = sanitizeKpParams(indicator.calcParams)
  const theme = asKpTheme(indicator.extendData)
  const reserve = theme?.reserve ?? 0
  const H = bounding?.height ?? Infinity
  const last = rows.length - 1
  const from = Math.max(0, visibleRange.from, P.showLast > 0 ? rows.length - P.showLast : 0)
  const to = Math.min(last, visibleRange.to)
  if (from > to) return true
  const boxH = P.fontSize + 2 * PAD
  const tri = Math.max(3, Math.min(6, (barSpace?.bar ?? 8) / 2))
  ctx.save()
  ctx.font = P.fontSize + 'px ' + FONT_FAMILY
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const widths = new Map<string, number>()
  const width = (s: string): number => {
    let w = widths.get(s)
    if (w === undefined) { w = ctx.measureText(s).width + 2 * PAD; widths.set(s, w) }
    return w
  }
  let placed: Rect[] = []
  const free = (r: Rect): boolean => r.y0 >= 0 && r.y1 <= H && !placed.some(p => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0)
  const label = (t: string, x: number, r: Rect, st: KpLabelStyle, top: boolean, y0: number): void => {
    const stemStart = top ? y0 - reserve - 2 : y0 + reserve + 2
    const stemEnd = top ? r.y1 - 1 : r.y0 + 1
    if (Math.abs(stemEnd - stemStart) >= 2) {
      ctx.beginPath?.()
      ctx.moveTo?.(x, stemStart)
      ctx.lineTo?.(x, stemEnd)
      ctx.strokeStyle = st.text
      ctx.lineWidth = 1
      ctx.stroke?.()
    }
    const w = r.x1 - r.x0
    if (st.fill) { ctx.fillStyle = st.fill; ctx.fillRect(r.x0, r.y0, w, boxH) }
    if (st.tint) { ctx.fillStyle = st.tint; ctx.fillRect(r.x0, r.y0, w, boxH) }
    if (st.stroke) { ctx.strokeStyle = st.stroke; ctx.lineWidth = 1; ctx.strokeRect(r.x0 + 0.5, r.y0 + 0.5, w - 1, boxH - 1) }
    ctx.fillStyle = st.text
    ctx.fillText(t, x, r.y0 + boxH / 2)
  }
  const totalPlots = KP_N + KP_BAIDU_N
  for (let i = from; i <= to; i++) {
    const row = rows[i]; const k = kLineDataList[i]
    if (!row || !k) continue
    const forming = i === last
    if (forming && !P.forming) continue
    const x = xAxis.convertToPixel(i)
    if (placed.length > 64) placed = placed.filter(p => p.x1 > x - 400)
    ctx.globalAlpha = forming ? FORMING_ALPHA : 1
    const marks = { top: 0, bottom: 0 }
    for (let n = 0; n < totalPlots; n++) {
      const p = n < KP_N ? KP_PLOTS[n]! : KP_BAIDU_PLOTS[n - KP_N]!
      const shown = n < KP_N ? P.show[n] : P.baiduShow[n - KP_N]
      if (!shown || !row[p.key]) continue
      const top = p.placement === 'top'
      const ref = top ? k.high : k.low
      if (ref === undefined) continue
      const y0 = yAxis.convertToPixel(ref)
      const st = kpStyle(P, n, theme)
      const slotTop = (s: number): number => (top ? y0 - GAP - reserve - boxH - s * (boxH + STACK) : y0 + GAP + reserve + s * (boxH + STACK))
      const shortText = KP_SHORT[p.key]
      const texts = P.mode === 1 ? [p.text] : P.mode === 2 ? [shortText] : P.mode === 3 ? [] : [p.text, shortText]
      const slots = P.mode === 0 ? AUTO_SLOTS : FORCED_SLOTS
      let done = false
      for (const t of texts) {
        const w = width(t)
        for (let s = 0; s < slots && !done; s++) {
          const yt = slotTop(s)
          const r = { x0: x - w / 2, x1: x + w / 2, y0: yt, y1: yt + boxH }
          if (free(r)) { placed.push(r); label(t, x, r, st, top, y0); done = true }
        }
        if (done) break
      }
      if (!done && (P.mode === 1 || P.mode === 2)) {
        // 用户指定了文字模式：放不下也照画，贴边截住不出界。
        const t = texts[0]!; const w = width(t)
        const yt = Math.max(0, Math.min(slotTop(0), H - boxH))
        const r = { x0: x - w / 2, x1: x + w / 2, y0: yt, y1: yt + boxH }
        placed.push(r); label(t, x, r, st, top, y0); done = true
      }
      if (!done) {
        // 小三角：看涨 ▲ 在低点下方，看跌 ▼ 在高点上方；同一根 K 线多个就往外叠。
        const m = marks[p.placement]++
        const h = tri * 1.6
        const tip = top ? y0 - GAP - reserve - m * (h + 2) : y0 + GAP + reserve + m * (h + 2)
        const base = top ? tip - h : tip + h
        ctx.beginPath(); ctx.moveTo(x, tip); ctx.lineTo(x + tri, base); ctx.lineTo(x - tri, base); ctx.closePath()
        ctx.fillStyle = st.text; ctx.fill()
        placed.push({ x0: x - tri, x1: x + tri, y0: Math.min(tip, base), y1: Math.max(tip, base) })
      }
    }
  }
  ctx.globalAlpha = 1
  ctx.restore()
  return true
}

/** klinecharts 注册（主图叠加；plotText 不画线，无 figures，不影响 Y 轴范围 —— 同 AiCoin excludeRange）。 */
export const kPatternIndicator = {
  name: 'AICOIN_KPATTERN',
  shortName: 'K线形态',
  series: 'price' as const,
  precision: 2,
  calcParams: [...KP_DEFAULTS],
  figures: [] as { key: string; title: string; type: string }[],
  calc: (dataList: readonly KpCandle[]) => calculateKPatterns(dataList),
  createTooltipDataSource: createKPatternTooltipDataSource,
  draw: drawKPatterns,
}
