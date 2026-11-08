/**
 * pipeline.js — 采集帧进来，出图出去。本包唯一有状态的地方。
 *
 * 一条链：
 *
 *   帧 → 打分 →（延迟一帧）切点判定 → 积分/兜底 → 留帧 → 档位 → pack.solve → 截断 → 出图
 *
 * 三个刻意的设计：
 *
 * ① **只延迟一帧**。切点判据要看"这一帧的分是不是尖峰"，需要前后各一个分，
 *    所以第 k 帧要到第 k+1 帧到手才判 —— 83ms，换来的是把"一拍二/手抖/粒子"挡在门外。
 *
 * ② **截断在采集侧，不在模型侧**。模型来问的时候图已经在队列里，模型思考 3 秒
 *    只是让队列多一张，不是延迟。
 *
 * ③ **档位数所有边界**（切点 + 积分 + 兜底），不是只数切点。一镜到底的素材没有切点，
 *    只数切点会让档位永远 1 档、一张图只放 4 帧。见 tiers.js 的推导。
 */

import { SCAN_H, SCAN_W, bgBorderChanged, bgKeep, createScorer, scorePair } from './cuts.js';
import { createTiers, applyStrategy } from './tiers.js';
import { packTiers, toRects, splitOneBin } from './pack.js';
import { composePacked, drawAudioStrip, stripHeight } from './sheet.js';
import { encodePng } from './png.js';
import { gridRects } from './layout.js';

export const DEFAULTS = Object.freeze({
  // 798 而不是 800：宽度向下对齐 42（patch 格），面积只少 0.25%，每张省 11 token。
  // runner 总会显式传 SIZES 里的值，这三个只是单独用 pipeline（测试/离线）时的兜底。
  width: 798,
  height: 450,
  fps: 12,

  /**
   * 切点：绝对值门槛 + 尖峰比 + 不应期。
   *
   * **25 → 15 → 7。** 25 是 storyboard 的口径（影视剪辑的硬切），实时屏幕这边差了一个数量级。
   * 同一条 12fps 链路上量"每 2 秒硬切一张照片"，门槛与命中数的关系：
   *
   * | 素材 | 换图那一帧的分 | 该有几刀 | 25 | 15 | **7** | 5 |
   * |---|---|---|---|---|---|---|
   * | 差异明显的照片 | 46.6~63.4 | 6 | 5 | 5 | 5 | 5 |
   * | 色调接近的照片 | 16.0~17.9 | 6 | **0** | 5 | 5 | 5 |
   * | 极相似（裁切差 8px） | 7.3~8.2 | 6 | **0** | **0** | 5 | 5 |
   * | 只改亮度 | 5.3 | 6 | 0 | 0 | 0 | 2 |
   * | 连续运动（合成片） | 峰值 11.7 / 中位 3.7 | 0 | 0 | 0 | **0** | 0 |
   * | 缓慢缩放 | 峰值 13.6 | 0 | 0 | 2 | 2 | 2 |
   * | 滚动网页 | 30~42 | — | 5 | 5 | 5 | 5 |
   * | 光标在静止画面移动 | 峰值 **0.7** | 0 | 0 | 0 | 0 | 0 |
   *
   * ## 默认取 12，而不是 7
   *
   * 7 能清掉全部 7 分以上的漏判，但那是**为了最难的素材**（7.3 分的极相似照片）定出来的。
   * 对日常屏幕它太敏感：切窗口、滚网页、点菜单都能过线，于是"每 8 秒叫一次"——
   * 用户实报"回复太密集、太烧钱"。
   *
   * 所以 7 改成**可选项**（`pace:"dense"`，见 runner.js 的 PACES），默认回到 12：
   * 幻灯片的正常切换（16 分以上）照抓，日常操作不再碎。
   *
   * ## 为什么不能"只留尖峰判据"（`cutAbs` 直接归零）
   *
   * 尖峰是**相对**的：`s > 2.5 × max(1, 前后帧)`。在低分区它同样成立 ——
   * 实测缓慢缩放那段有两帧 `s=13.6`、前后邻居只有 1.1 / 1.3，门槛算出来是 3.3，
   * **尖峰判据完全放行**。也就是说没有绝对地板的话，缓慢的持续运动会被切成一块块。
   * 地板负责区分"这是很大的变化"和"这只是动了一下"，尖峰负责区分"这是一下子"
   * 和"这是一直在动"。两个都要。
   *
   * 顺带一个反直觉的数：**光标移动只有 0.7 分**。静止桌面上真的什么都没有时，
   * 分数就是 0.00（屏幕采集近似无损）。所以地板不防光标 —— 它防的是持续运动。
   *
   * ## 漏判为什么不只是"少一帧"
   *
   * 判不出切点就落到积分，而积分是给**连续运动**标定的
   * （中等运动 4 分/帧 × 12fps × 3 秒 = 144）。幻灯片是"1 帧有值 + 23 帧归零"，
   * 每 2 秒只进账十几分 —— 要换 8~9 张照片才攒够一帧，看着就像"根本没反应"。
   */
  cutAbs: 12,
  cutSpike: 2.5,
  /**
   * 尖峰判据的**绝对地板**：`s` 除了要比前后两帧高 2.5 倍，还得够到这个数。
   *
   * 默认 0 = 不额外要求（行为和以前完全一致）。给 action 档用：那一档把倍率降到 1.5
   * （动作游戏里"前后两帧"本身就很高，2.5 倍根本凑不出来），倍率一松就必须靠绝对地板
   * 兜住噪声，否则满屏都是切点。
   */
  cutSpikeAbs: 0,
  cutMinGap: 0.4,

  /**
   * 运动补偿切点（mc）：整屏平移能被邻域吸收，换镜头不能。这是"运镜中切机位"的
   * 直接证据，不靠绝对分台阶。
   *
   * - `cutMcRadius` 默认 4：实测随机纹理平移 8 格时，radius=2 的 mc 高达 194，
   *   radius=4 只有 5；快速运镜因此不会被当成切点。
   * - `cutMcAbs` 默认 60：B 站游戏片里真切点 30.33s（abs 23.2 / mc 121）、
   *   39s（abs 35.5 / mc 68）能过；UI 面板变化（abs 6~12 / mc 10~18）不过。
   * - `cutMcMinScore` 是绝对分地板，挡住纯 UI 小变化；0 关闭整条路径。
   */
  cutMcRadius: 4,
  cutMcAbs: 60,
  cutMcMinScore: 6,
  /** 尖峰切点也要有 mc 覆盖，避免在真切换前 0.4s 的过渡帧先切一刀；0=不查。 */
  cutSpikeMcAbs: 20,

  /**
   * 相似构图/相似主体的弱切点。
   *
   * 这类切点整屏平均分只有 7~8（低于 cutAbs=12），但前后邻居接近 0 ——
   * 不是“运动”，而是孤立的一下子。给一个更低、但要求**更尖**的绝对地板：
   * 6 分以上、高于前后邻居 3 倍，且 mc 覆盖率 ≥8、变化包围盒 ≥20、包围盒填充率 ≥0.2。
   * 只改亮度（约 5.3 分）不会被误判；B 站 UI 小面板 mc 只有 1~18，bbox 虽大但很稀
   * （填充率 0.01~0.11），会被填充率挡掉；真正的相似构图主体占 20×10，填充率约 0.4。
   * 0 = 关闭。
   */
  cutIsolatedAbs: 6,
  cutIsolatedSpike: 3.0,
  cutIsolatedMcAbs: 8,
  cutIsolatedMcBBox: 20,
  cutIsolatedFill: 0.2,

  /**
   * 背景模型 / 前景运动抑制。
   * 稳定背景格被改掉的比例（bgStats 的 score，0–255）低于 `cutBgAbs`，
   * 且变化区域没有盖满有效画面高度（`mcSpanY / activeY < cutBgMaxSpanY`，上下黑边不计）时，
   * 视为手/勺子/遮挡物这类前景运动，不切。只在分数低于 `cutBgMaxScore`
   * 且不是孤立弱切点时启用；真正切镜头会把稳定背景整片换掉（几百），
   * 前景运动只换一部分（几十）。`cutBgMinCells` 太少时不可信，直接不启用；
   * `cutBgMaxChanged` 是绝对变化格数上限：稳定背景格很多时，比例低也可能已经是
   * 真切镜头（实测开箱视频 18.67s 比例 89/255，但变了约 700 格），这类不挡。
   */
  cutBgAbs: 100,
  cutBgMaxScore: 60,
  cutBgMinCells: 128,
  cutBgMaxChanged: 600,
  cutBgMaxSpanY: 0.85,
  cutBgWindow: 6,

  /**
   * 未来帧确认（只用于高分候选）：
   * 高分镜头可能把大面积前景运动当切点；等 `cutFutureDelay` 秒后，
   * 再看候选帧改掉的格子有多少还没回到参考背景（最近 `cutFutureRefWindow` 帧）。
   * 低于 `cutFutureKeep` 的判为短暂前景运动，不切。真正换镜头在新场景里稳定下来，
   * keep 很高；候选帧前的前景离开（画面回到旧背景）也会被 `bgKeep` 抓到。
   * 高分前景停住时，外圈通常还是旧背景（`bgBorderChanged`），
   * 背景变化不算整片且外圈几乎不动时也判为前景。
   * 0 = 关闭未来帧确认。
   */
  cutFutureDelay: 0.5,
  cutFutureMinScore: 60,
  cutFutureKeep: 100,
  cutFutureMinChanged: 64,
  cutFutureRefWindow: 24,
  /** 外圈变化低于这个值（0–255）且背景仍稳定时，判为停住的大面积前景。 */
  cutFutureBorderMax: 10,
  /** 低/中分候选若背景仍有一块没变，也做未来帧确认。**0 = 整条关闭低分未来帧确认**。 */
  cutFutureLowBgMax: 160,
  /** 低/中分候选的外圈被改掉多少（大面积前景盖到边缘）才值得未来确认。 */
  cutFutureLowBorderMin: 60,
  /** 稳定背景格数太少时，优先怀疑大面积前景，而不是整屏新场景。 */
  cutFutureLowStableMax: 700,
  /** 低/中分候选的 keep 门槛更宽：只有一部分旧背景回来就可能是前景/移动。 */
  cutFutureLowKeep: 210,
  /** 稳定背景特别少的候选（大量前景占住画面）门槛再宽一点，避免 198/210 的薄余量。 */
  cutFutureLowStableTight: 300,
  cutFutureLowKeepTight: 220,
  /** bg 很高但稳定背景极少时，也可能是整屏前景；仍然给一次未来帧确认。 */
  cutFutureLowBgHigh: 220,
  /** 低分候选也要有参考背景模型才能做上面这次确认。 */
  cutFutureBuildMinScore: 12,

  /**
   * 运动中的切机位。
   *
   * 原 spike 要求 `s > 2.5 × max(前,后)`；机位切换前后都有人在动/镜头在摇时，
   * 前后分也很高，真切点反而被 2.5 倍卡掉（实测 117 分，前后 73/54，只到 1.6 倍）。
   * 这里额外允许“绝对分够高 + 比邻居高出一截”的台阶：
   *   0 = 关闭；默认 80 分、跳 12 分、至少 1.5 倍。
   */
  cutJumpAbs: 80,
  cutJumpMargin: 12,
  cutJumpRatio: 1.5,

  /**
   * 积分取帧（伪切点）：沿时间**累加画面变化量**，累够就录一帧、清零。
   *
   * 这就是 Storyboard 的算法，不是等间隔抽样。区别在于**阈值是固定的绝对值**：
   *
   *     need = REF_SCORE × fps × integralSeconds
   *
   * 画面动得快 → 每帧分高 → 很快累够 → 密集出帧；
   * 画面静止   → 每帧分趋近 0 → 永远累不够 → 一帧都不出。
   *
   * 早先这里是 `阈值 ∝ 平均变化量`（`motionExp` 那套），那样阈值永远跟着画面一起涨，
   * 结果**不管画面动得多快都是固定 N 秒一帧** —— 等于把积分退化成等间隔抽样，
   * 已经把 `motionExp` 删了。
   *
   * `integralSeconds` 的语义：**一段"中等强度"画面，攒够这么多秒才算一个采样点**。
   * 不是"每 N 秒取一帧"。
   */
  integralSeconds: 3,
  /** 两帧之间至少隔这么久 —— 这是"最快不超过半秒一帧"的**硬上限**，不是出帧节奏。 */
  markMinGap: 0.5,
  /** 画面完全静止时的兜底：这么久都没出帧就给一张，否则模型会一直拿到"没更新"。 */
  silentFloorSec: 20,
  /**
   * **按出帧节奏自适应**（比按活跃度更直接）：兜底 = clamp(k × 近期出帧间隔, floorMin, floorMax)。
   *
   * 为什么按间隔而不是按活跃度：分数高的地方本来就会连续出帧，低谷期才需要兜底；
   * 而"平时 2 秒一张、突然 8 秒没动静"正是该补一张的信号。
   * 静态画面下近期间隔会被拉长到 floorMax，等价于旧行为。
   *
   * 0 = 关闭（用固定 silentFloorSec）。
   */
  floorGapK: 0,
  /**
   * 自适应兜底的上下界（秒）。**必须给默认值**：`PACES` 里三档都显式传了，
   * 但直接 `createPipeline({floorGapK: 2})` 时它们是 undefined，
   * `Math.min(undefined, …)` 得到 NaN → `elapsed >= NaN` 永远 false →
   * **兜底帧一帧都不会出**（画面静止时就再也不给图了）。这种静默坏死最难查。
   */
  floorMin: 2,
  floorMax: 20,
  /** 和上一张留下的帧差小于这个分就不留（0–255 刻度，见 cuts.js）。 */
  dupMin: 8,

  /**
   * 打分口径：'abs' = 逐格 HSV 差均值（历史行为）；'mc' = 运动补偿后的"变了多少格"占比（×255）。
   *
   * mc 的用处是**把"整屏在动"和"换画面"分开**：游戏/高速画面里前者会把 abs 分数顶满，
   * 而 mc 只统计"邻域里找不到对应"的格子，运动被吸收掉。实测（storyboard 侧，同一判定）
   * 短视频 69.8→74.4、纪录片 86.1→89.4。
   *
   * 默认 'abs'：阈值（cutAbs / 积分 / 下限）都是按 abs 刻度标定的，切到 mc 需要重新标定。
   */
  scoreMode: 'abs',
  mcTau: 15,
  mcRadius: 2,
  /**
   * 亮度归一 + 黑边补偿（`cuts.js` 的 `normalizeScore`）：把绝对分换算到"参考亮度、
   * 无黑边"的刻度上，让 `cutAbs: 12` 在夜戏和亮画面里指的是同一件事。
   *
   * **默认开**，理由有证据：暗场真切点只有约 5 分（门槛 12 永远够不着），2.39:1 的片子
   * 加黑边后 9 个硬切从 9/9 掉到 7/9。亮场（V ≥ 160）gain 恒等于 1、无黑边时 barFrac = 0，
   * **逐位返回原分数** —— 也就是说这个开关对正常素材是 no-op。
   *
   * `false` = 完全回到 0.1.3 的行为（回滚通道，`~/.dsh/see-now.json` 的
   * `"scoreNormalize": false`）。只影响 `scoreMode: 'abs'`；`mc` 是另一套刻度，不动。
   */
  scoreNormalize: true,

  // 档位
  dtFrames: 12,
  smoothFrames: 6,
  /**
   * 档位阈值表：`docx`（默认，照抄 docx 的七道 × 30）或 `perceptual`
   * （按人眼瞬时记忆 / 主观现在的实测时长重排，见 `tiers.js` 的 `PERCEPTUAL_THRESHOLDS`）。
   * 只影响"密度 → 档位"这一段，切点和拼图不动。
   */
  tierCurve: 'docx',
  /**
   * 七道阈值自己填（帧/秒，严格递增）。**填了就以它为准**，`tierCurve` 只当名字用 ——
   * 设置页选「自定义」时走这条路。非法值在 `tuning.js` 那边就被挡掉了，这层不重复校验。
   */
  tierThresholds: null,
  /**
   * 档位怎么算：
   * - `density`（默认）：看过去 1 秒**平均每秒几帧**（邻域密度，走 EMA）；
   * - `weight`：出图时按这一帧的变化分切面积（见 `seqOf`）—— 才有"同一张图里大小对比"。
   *
   * 两者都是"尺寸 = 重要性"的近似：模型没有瞬时视觉，格子大小是唯一能说
   * "这一刻值得端详 / 只是扫过去"的通道。
   */
  tierMode: 'density',
  /**
   * 排布算法：`rows`（默认，按行流式 + DP）或 `skyline`（天幕，按最低可放位置塞）。
   *
   * 行式在**尺寸均匀**时最优；一旦尺寸混排（`tierMode:'weight'` 就是），一行凑不满
   * 就整块留空。天幕把小的叠在大的旁边，洞没了，代价是布局不再是整齐的行。
   */
  packMode: 'rows',
  strategy: 'native',
  /**
   * `strategy: 'custom'` 时的查表（档位 1..8 → 目标档位）。
   * 其它策略忽略它 —— 那份表只对"逐档自定义"有意义。
   */
  tierMap: null,
  /**
   * **积分假切点的档位加成**（照抄 storyboard 的 `MARK_BOOST`，但加了帧数门槛）。
   *
   * 真切点是"换镜头"，假切点是"这一段一直在变、攒够了才切"——后者没有硬边界，
   * 一帧代表不了多久，所以给**更小的格子**（档位数字越大格子越小，1/k²）。
   *
   * ## 为什么不能像 storyboard 那样无条件加
   *
   * storyboard 是批量出图，压小档位还有 `fillGaps` 补位；实时是逐帧追加，压小就散。
   * 实测同一段 30 秒素材：
   *
   * | 帧密度 | boost=2 | boost=0 |
   * |---|---|---|
   * | 稀（4.5 帧/张） | fill 63% | **fill 94%** |
   * | 密（5 帧/张）   | **1296 token/分 · 43/帧** | 1728 token/分 · 58/帧 |
   *
   * 帧稀的时候压档是白扔画布（格子小了一圈，帧数没多）；帧密的时候压档才真的
   * 多塞帧、省 token（每张 216 token 是固定的，塞 5 帧比塞 4 帧便宜 26%）。
   *
   * 所以加成只在"这张图有 `boostMinFrames` 帧以上"时才生效 —— 这个判断放在
   * `flush()` 里，因为那时才知道最终几张。
   */
  markBoost: 2,
  /** 兜底帧也压一档：它是"实在没东西可看，凑一张"，不该占大格子。 */
  floorBoost: 1,
  /** 满这么多帧才应用上面两项加成（帧太少时压档只会浪费画布）。 */
  boostMinFrames: 4,

  // 截断
  maxWaitSec: 15,
  flushGain: 0.015,
  maxFrames: 40,
  /**
   * 箱子代价。**实时场景必须远大于 1**：
   * storyboard 是批量出图，多开一张只是多花一张图（默认 222 token）；实时一次只发一张，
   * 「排成两张」等于把半张图扔掉。默认 1.02 会让「两个 1 档帧」直接判成两张各 100%
   * （实测：25 秒素材出 9 张，每张 1 帧）。给到 1000，DP 就只会往一个箱子里压。
   */
  binCost: 1000,
  /** 出图队列深度。0 = 不丢（离线跑用），线上是 1：宁可丢老画面，不给模型看十几秒前的事。 */
  queueDepth: 1,
  /**
   * 变化日志：交付时在图下面附一段「这期间屏幕怎么动的」（时间/变化分/方位）。
   *
   * 默认关 —— 它给交付文本加约 100 token，属于"按需打开"的能力，不该改所有人的
   * 默认成本。`queueDepth: 1` 挤掉的画面恰恰是这条日志唯一能补回来的东西。
   */
  changeLog: false,
  /** 变化日志最多留多少条（超出丢最旧）。60 条 ≈ normal 档十几分钟。 */
  changeLogMax: 60,
  /** 只发一帧就截断。刚开/刚换清晰度时用：让模型马上拿到"现在是什么"，不用等攒满一张。 */
  oneShot: false,
  /**
   * 图底下那条音轨（响度柱 + 切点刻度）。
   *
   * `audio` 是取数回调 `{levels(wallFrom, wallTo) → {step, db[]}}`，由 runner 从
   * 听声音那条链接过来；没有它就只能画刻度、画不出柱子。`false` = 彻底不要。
   *
   * 代价：条高 = 画面占行后剩下的余量（450 余 12、600 余 30），**不跨行**所以 token 不涨。
   */
  audioStrip: true,
  audio: null,
});

/**
 * 参考强度（0–255 刻度）：一段"中等强度"画面每帧的变化分。
 *
 * 标定自本机素材（`scripts/sim.mjs` 打印的"运动强度"就是它）：
 *   真屏幕静止      0（完全不动，分数就是 0）
 *   合成动画素材    4.4 / 5.5
 *   网页滚动、视频  8–20（估计，下同）
 *   快速切窗口      40+
 *
 * 所以取 4：轻微运动能出帧，完全静止仍然出不了 —— 这才是积分该有的样子。
 * （取 8 时那两支素材要 4.4 秒才够一个采样点，实测 30 秒只出 3 帧，太稀。）
 */
export const REF_SCORE = 4;

export function createPipeline(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { width, height, fps } = o;

  /**
   * region 模式（只抓一块竖屏窗口）：`o.region` 存在时走一套独立的几何。
   *
   * 此时 `width/height` 的语义变成**单格尺寸**（runner 用 layout.cellSize 按
   * 「长边 = 档位长边」算好后传进来），不是整张画布的尺寸 —— 画布尺寸要等
   * 出图时按实际帧数（2 帧 2×1 / 4 帧 2×2）才算得出来。
   * 为 null 时整条老路径（pack 的 DP + coverInto + 16:9 常量）一行不变。
   */
  const regionAspect = o.region ? o.region.w / o.region.h : null;

  const scorer = createScorer({
    width, height, scoreMode: o.scoreMode, mcTau: o.mcTau, mcRadius: o.mcRadius,
    gateMcRadius: o.cutMcRadius, bgWindow: o.cutBgWindow, bgModel: o.cutFutureDelay > 0,
    bgRefWindow: o.cutFutureDelay > 0 ? o.cutFutureRefWindow : 0,
    scoreNormalize: o.scoreNormalize,
    futureMinScore: o.cutFutureDelay > 0
      ? Math.min(o.cutFutureMinScore, o.cutFutureBuildMinScore)
      : o.cutFutureMinScore,
  });
  const tiers = createTiers({
    fps,
    dtFrames: o.dtFrames,
    smoothFrames: o.smoothFrames,
    curve: o.tierCurve,
    thresholds: Array.isArray(o.tierThresholds) && o.tierThresholds.length === 7
      ? o.tierThresholds.map(Number)
      : undefined,
  });

  let q = [];                  // 待判的帧（未来帧确认时最多 ~delay*fps 帧）
  let lastScore = null;
  let acc = 0;                 // 积分累加
  let lastCut = -Infinity;
  let lastBound = -Infinity;
  /** 近期"出帧间隔"的滑动平均（按节奏自适应兜底用） */
  let gapEwma = 0;
  let lastKeepT = null;
  let lastSeen = null;         // 最近解出来的一帧（插话时如果本张是空的，拿它兜底）
  let sheetStart = 0;          // 本张第一帧的时刻（maxWaitSec 从这儿算）

  let lastKeptHsv = null;      // 上一张留下来的帧（去重基准）
  let frames = [];             // 本张待发
  let sheets = [];
  /**
   * 切点时刻（相对秒）。只在图上画刻度用 —— `log` 里也有，但那个是离线标定用的全量记录，
   * 长期跑会一直涨；这里只留切点，几百个顶天了。
   */
  const cutTimes = [];
  const log = [];              // 每一帧为什么留下（离线标定用）

  const stats = {
    frames: 0, kept: 0, cuts: 0, marks: 0, floors: 0, dupSkipped: 0,
    sheets: 0,
    /**
     * 留下的帧落在哪些档位：`{1: 3, 3: 12}`。
     *
     * 加它是因为"格子在变"有两级原因（节奏档位 → 密度 → 档位，再由 strategy 偏移），
     * 用户看到图变了却不知道为什么。`status` 报一行分布，能直接看出是"帧太少所以格子大"
     * 还是"映射被改了"。
     */
    tierHist: {},
    scoreSum: 0, scoreN: 0, scoreMax: 0,
    /** 多箱兜底触发次数（>0 说明调用方没切干净，画面会被丢帧而不是糊掉） */
    overflow: 0,
  };

  /**
   * 变化日志：每出一张图记一条**摘要**（不是图）。
   *
   * 为什么要有它：`queueDepth: 1` 在模型没跟上时会把旧图挤掉 —— 模型回来只看到
   * "现在"，不知道刚过去那十几秒屏幕怎么动的。摘要每条几十字节，交付时压在
   * 图下面，模型就能判断"这期间是弹了窗、滚了页，还是根本没动"。
   *
   * 开关是 `opts.changeLog`（`~/.dsh/see-now.json` 的 `changeLog`），默认关：
   * 不改变现有交付体积。键名和 `log` 区分开 —— `log` 是离线标定用的全量记录。
   */
  const changes = [];

  function noteChange(sheet, used) {
    if (!o.changeLog) return;
    const scored = used.filter((f) => typeof f.score === 'number' && Number.isFinite(f.score));
    const peak = scored.length ? Math.max(...scored.map((f) => f.score)) : 0;
    let box = null;
    const boxes = used.map((f) => f.mcRect).filter(Boolean);
    if (boxes.length) {
      const x0 = Math.min(...boxes.map((b) => b.x0));
      const y0 = Math.min(...boxes.map((b) => b.y0));
      const x1 = Math.max(...boxes.map((b) => b.x1));
      const y1 = Math.max(...boxes.map((b) => b.y1));
      // 网格坐标 → 0..1 比例：交付层只关心"在画面哪个位置"，不关心 64×36 的格号
      box = {
        x0: +(x0 / (SCAN_W - 1)).toFixed(2),
        y0: +(y0 / (SCAN_H - 1)).toFixed(2),
        x1: +(x1 / (SCAN_W - 1)).toFixed(2),
        y1: +(y1 / (SCAN_H - 1)).toFixed(2),
      };
    }
    changes.push({
      at: +sheet.at.toFixed(2),
      from: +sheet.from.toFixed(2),
      to: +sheet.to.toFixed(2),
      n: used.length,
      peak: +peak.toFixed(1),
      cut: used.some((f) => f.via === 'cut'),
      box,
    });
    // 只留最近 `changeLogMax` 条：旧条目价值掉得快，留太多只是把交付文本拉长
    const max = o.changeLogMax > 0 ? o.changeLogMax : 60;
    while (changes.length > max) changes.shift();
  }

  /**
   * 积分阈值：**固定的绝对值**，不随画面变化。
   *
   *     need = REF_SCORE × fps × integralSeconds
   *
   * REF_SCORE 是「中等强度画面每帧的变化分」（8 是标定出来的中位数，0–255 刻度）。
   * 于是一段中等画面要攒 integralSeconds 秒才够一个采样点；画面比它动得快就更快累够，
   * 比它静就永远累不够 —— 这才是"运动多给几帧"，而不是固定 N 秒一帧。
   */
  function integralNeed() {
    return REF_SCORE * fps * o.integralSeconds;
  }

  function keep(entry, via) {
    // 去重：和**上一张留下来的帧**太像就不留。一镜到底的素材没有切点，积分会被
    // 雨点/树叶/传感器噪声推着一直触发，25 秒能留 9 张几乎一样的画面。
    // cut / floor 不过这道闸：切点本来就是新画面，floor 是兜底不能吞。
    let dup = null;
    if (lastKeptHsv && entry.hsv) dup = scorePair(lastKeptHsv, entry.hsv);
    if (dup !== null && dup < o.dupMin && via !== 'cut' && via !== 'floor') {
      stats.dupSkipped += 1;
      return false;
    }
    tiers.mark(entry.t);
    /**
     * `tierMode: 'density'` —— 档位只由**邻域密度**决定，`keep` 这一层不再看别的信号。
     *
     * （这里删掉过 `dwell`：按"这一段在屏幕上停了多久"给尺寸。五段素材零次胜出，
     * 因为采样间隔是我们自己定的、不携带内容信息。详见 `tiers.js` 里那段注释。）
     */
    const lv = tiers.levelAt();
    // 这里**只按密度给档位**，不加假切点加成 —— 加成要等出图时按最终帧数决定
    // （见 DEFAULTS.markBoost 的实测表）。keep 阶段用它判断"装不装得下"，
    // 用不带加成（更大）的档位是保守的：判装不下而实际装得下，顶多多开一张，不会丢帧。
    const tier = applyStrategy([lv], o.strategy, o.tierMap)[0];
    if (frames.length === 0) sheetStart = entry.t;
    // `score` / `mcRect` 一起带下去：出图时要拿它们写变化日志（见 `noteChange`）。
    // 以前只留在 `log` 里，而 `log` 是离线标定用的全量记录、不会交付。
    frames.push({
      t: entry.t, buf: entry.buf, tier, via, level: lv, wall: entry.wall,
      score: entry.score, mcRect: entry.mcRect,
    });
    if (entry.hsv) {
      lastKeptHsv ??= new Float32Array(entry.hsv.length);
      lastKeptHsv.set(entry.hsv);

    }
    log.push({
      t: +entry.t.toFixed(2), via, level: lv, tier, score: +(entry.score ?? 0).toFixed(1),
      dup: dup === null ? null : +dup.toFixed(1),
      /**
       * 补偿的中间量。**标定必须看得见它**：只看到 `score` 就分不清"切点多是因为门槛低"
       * 还是"因为 gain 把分数顶上去了"，而这两个的修法完全不同。
       */
      raw: entry.raw === null || entry.raw === undefined ? null : +entry.raw.toFixed(1),
      gain: entry.gain === undefined ? null : +entry.gain.toFixed(2),
      bar: entry.bar === undefined ? null : entry.bar,
    });
    lastBound = entry.t;
    if (via === 'cut') cutTimes.push(+entry.t.toFixed(2));
    if (lastKeepT !== null) {
      const g = entry.t - lastKeepT;
      gapEwma = gapEwma === 0 ? g : gapEwma + (g - gapEwma) * 0.3;
    }
    lastKeepT = entry.t;
    stats.kept += 1;
    stats.tierHist[tier] = (stats.tierHist[tier] ?? 0) + 1;
    if (via === 'cut') stats.cuts += 1;
    else if (via === 'mark') stats.marks += 1;
    else if (via === 'floor') stats.floors += 1;
    // 一次性：留下第一帧就立刻发，不等判据
    if (o.oneShot && frames.length === 1) { o.oneShot = false; flush(entry.t, 'oneshot'); return true; }
    checkFlush(entry.t);
    return true;
  }

  /**
   * 当前这批帧的排布预案。
   *
   * **必须和 `flush()` 用同一个档位口径**（都走 `seqOf`）。早先用 `f.tier`（不带加成）
   * 判断容量，结果是"第 4 帧一到就判装不下 → 提前封箱"，加成永远追不上，
   * 实测帧密场景还是 4 帧/张、token/分一点没省。
   */
  function plan() {
    return packTiers(seqOf(frames), { binCost: o.binCost, packMode: o.packMode });
  }

  function checkFlush(t) {
    if (frames.length === 0) return;

    /**
     * region 模式：不走 pack 的装箱判定 —— 那套是为「一张图塞多帧、格子随密度变小」
     * 设计的，竖屏一格一帧用不上，硬套还会因为 `bins > 1` 误触发截断。
     *
     * 这里只决定**几张出一张图**：
     *   硬上限 4 —— 6 帧就要 3×2 或 6×1，后者长宽比 3.4，今天实测就是它糊掉的；
     *   期望 2   —— 竖屏 2 帧并排 = 1.125，最接近 1:1。
     *
     * `regionAspect === null` 时这段**不可达**，普通路径一个字节不动。
     */
    if (regionAspect) {
      const cap = Math.max(1, Number(o.maxFrames) || 4);
      const prefer = Math.min(cap, Math.max(1, Number(o.preferFrames) || 2));
      if (frames.length >= cap) { flush(t, 'cap'); return; }
      if (frames.length >= prefer) { flush(t, 'prefer'); return; }
      // 只有一帧时等兜底。**region 单独封顶 30 秒**：0.0.8 的 action 档把
      // `maxWaitSec` 设到 60，×2 = 120 秒 —— 拿这个抓「用户想让我看的东西」，
      // 举着不动两分钟才给一张图就废了。30 秒够判断静止，普通路径的 maxWaitSec 不动。
      const singleWait = Math.min(30, o.maxWaitSec * 2);
      if (frames.length === 1 && t - sheetStart >= singleWait) { flush(t, 'time'); return; }
      return;
    }

    const p = plan();

    // 硬：装不下了。**从末尾退到真装得下为止**，退出来的留给下一张（保序、不丢帧）。
    //
    // 旧写法是"退一帧"，实测也是对的 —— 因为它依赖 `boostMinFrames=4` 与
    // "4 个 1 档装得进一张"刚好咬住（见 `splitOneBin` 的注释）。这里换成显式规则：
    // 不依赖那两个数字，改加成参数也不会静默交出一张糊图。
    if (p.bins > 1) {
      const segs = splitOneBin(seqOf(frames), { binCost: o.binCost, packMode: o.packMode });
      const keep = segs[0].length;
      const carry = frames.slice(keep);
      if (carry.length === 0) { flush(t, 'full'); return; }   // 兜底：不该发生
      frames = frames.slice(0, keep);
      flush(t, 'full');
      frames = carry;                  // 下一张的起点
      sheetStart = frames[0].t;
      lastBound = frames[frames.length - 1].t;
      return;
    }

    const last = p.cells[p.cells.length - 1];
    const cellArea = last ? last.w * last.h : 1;

    // 软：这一帧只占得到 1.5% 了（7 档 2.04% / 8 档 1.56%），再塞就是碎格
    if (frames.length >= 2 && cellArea < o.flushGain) {
      flush(t, 'crumb');
      return;
    }

    // 时间：从**这一张的第一帧**算起，不是从上一张算起。
    // 从上一张算的话，一张刚 flush 完 12 秒后来的那一帧会立刻被单独发出去（实测 3 张单帧图）。
    // 只有一帧时不按时间发：静态画面下等于每 15 秒扔一张单帧图（222 token 换一个没变）。
    // 等下一帧（兜底帧最晚 20 秒到）再走这张，两帧还能并排铺一半。
    // 单帧也有封顶：等满两倍 maxWait 还没等到第二帧，那就是没人来看了，发出去收工。
    //
    // **门槛是 3 帧不是 2 帧**：一张图固定 222 token，2 帧等于每帧 121 token，
    // 4 帧只有 58 —— 差一倍。少发一张、等第三帧，性价比直接翻倍（实测 0273 这类
    // 静止素材 2 帧/张 → 3 帧/张，token/帧 116 → 78）。
    if (frames.length >= 3 && t - sheetStart >= o.maxWaitSec) {
      flush(t, 'time');
      return;
    }
    /**
     * **两帧也要有时间出口**。
     *
     * 静止画面只有兜底帧：第一帧在 0s、第二个兜底帧在 20s，若继续等第三帧，
     * 首图会拖到 40s（README 写的是“静止 20 秒给一张”）。这里到 `maxWaitSec`
     * 就发两帧：token/帧比三帧贵，但“一直不回来”比贵更不能接受。
     */
    if (frames.length >= 2 && t - sheetStart >= o.maxWaitSec) {
      flush(t, 'time');
      return;
    }
    if (frames.length === 1 && t - sheetStart >= o.maxWaitSec * 2) {
      flush(t, 'time');
      return;
    }

    if (frames.length >= o.maxFrames) flush(t, 'cap');
  }

  /**
   * 给一张已经拼好的图接上音轨条（响度柱 + 切点刻度）。
   *
   * **尺寸必须恒定**：只要 `audioStrip` 没关就画，哪怕这一刻还没有音量数据
   * （刚启动、或者用户根本没开音频）。否则同一档清晰度的图会时高时低，
   * 模型那边的 token 预算就没法估了 —— 而省下这 20 token 远比"尺寸不可预测"不值。
   * 没有响度时条上只剩切点刻度，那也是有用的信息。
   *
   * 时间轴：条上的 x 用 `from..to`（相对秒，和格子里烧的编号同一套），
   * 响度序列用 `wall` 去取 —— 音频只有墙上时间，`t` 掉帧会漂。
   */
  /**
   * 这一档要不要画音轨条，以及它有多高。
   *
   * **region 模式永远不加条**：那里的画布是"一小块窗口"（竖屏时 800×450、更窄的只有 200 宽），
   * 按宽度比例算的条会吃掉 10% 以上，而 region 的用途是"把这块看清"，不是看视频节奏。
   */
  function stripHeightFor() {
    if (o.audioStrip === false || regionAspect) return 0;
    return stripHeight(width, height);
  }

  /** 取这一张时间窗里的响度与切点（没有音频链路时只返回切点）。 */
  function audioOf(first, last) {
    const lv = (first.wall && last.wall && o.audio?.levels)
      ? o.audio.levels(first.wall, last.wall)
      : null;
    const cuts = cutTimes.filter((c) => c >= first.t && c <= last.t);
    return { loudness: lv, cuts, window: { from: first.t, to: last.t } };
  }

  /**
   * region 模式的出图：一帧一格，按 `gridRects` 摆成网格（2 帧 2×1 / 4 帧 2×2）。
   *
   * **源帧尺寸 === 单格尺寸**：采集时 ffmpeg 的 `scale=cellW:cellH` 已经按 region
   * 的比例等比缩放好了，所以这里把 `buf` **直接搬进格子**。
   * 绝不能再做一次 cover / scale —— 那会把「不拉伸」这个验收直接毁掉
   * （coverInto 是保持比例的裁边，喂进来的正好同比例，裁掉的就是画面本身）。
   */
  function flushRegion(batch, t, why) {
    const n = batch.length;
    const g = gridRects(n, width, height, regionAspect);
    const cells = batch.map((f) => ({ buffer: f.buf, w: width, h: height }));
    const img = composePacked({
      frames: cells, rects: g.rects, width: g.width, height: g.height, burn: 'index',
    });
    const png = encodePng(img.buffer, img.width, img.height, { level: 3 });
    if (o.queueDepth > 0 && sheets.length >= o.queueDepth) sheets.shift();
    const sheet = {
      at: t,
      from: batch[0].t,
      to: batch[n - 1].t,
      png,
      w: img.width,
      h: img.height,
      fill: 1,
      area: 1,
      bins: 1,
      why,
      strip: img.stripH ?? 0,
      wallFrom: batch[0].wall ?? null,
      wallTo: batch[n - 1].wall ?? null,
      frames: batch.map((f) => ({
        t: +f.t.toFixed(2), tier: 1, level: f.level, via: f.via, wall: f.wall ?? null,
      })),
      cells: g.rects.map((r) => ({ px: r.px, py: r.py, pw: r.pw, ph: r.ph, tier: 1 })),
    };
    sheets.push(sheet);
    stats.sheets += 1;
    noteChange(sheet, batch);
    return sheet;
  }

  function flush(t, why) {
    if (!frames.length) return;
    const batch = frames;
    frames = [];
    // region 模式：一帧一格，不走 pack 的 DP（也不做任何二次缩放）
    // **必须 return** —— `flushNow()` 靠这个返回值拿图，返回 undefined 会让它
    // 清空了 sheets 却交不出图（插话时用户什么都看不到）。
    if (regionAspect) return flushRegion(batch, t, why);
    const seq = seqOf(batch);
    const p = packTiers(seq, { binCost: o.binCost, packMode: o.packMode });
    if (!p.cells.length) return;
    /**
     * **一张图只画一个箱子**。`solve` 允许跨箱（DP 里封箱是要付 `binCost` 的），
     * 而 `cells` 会带上所有箱的格子、只靠 `bin` 字段区分 —— 不过滤就画，
     * 第二箱的 y 从 0 重新开始，直接盖在第一箱上。
     *
     * 正常情况下调用方已经保证单箱（`checkFlush` / `finish` 都先切过），
     * 这里是最后一道闸：宁可少画几帧，也不能交一张糊在一起的图。
     */
    const kept = p.cells.filter((c) => c.bin === 0);
    const used = batch.slice(0, kept.length);
    if (used.length < batch.length) stats.overflow += 1;
    const rects = toRects(kept, { width, height, gutter: 0 });
    /**
     * 帧直接以 `{src, sw, sh}` 交给 `composePacked`：它内部用 `coverIntoAt`
     * 把每一帧缩进画布的对应格子。
     *
     * 旧链路是「每格 alloc 中间缓冲 → coverInto → blit 到画布」，等于每格多做
     * 一次 267KB 的分配和一次同样大小的拷贝；4 格图纯搬运就是 1MB。现在零中间缓冲。
     */
    const cells = used.map((f) => ({ src: f.buf, sw: width, sh: height }));
    const stripH = stripHeightFor();
    const img = composePacked({
      frames: cells, rects, width, height, burn: 'index', stripH,
    });
    // 音轨条：响度 + 切点刻度。**画布已经预留好高度**，这里是就地填底部，
    // 不再额外分配 + 拷贝一整张图（省 1.1MB/张）。
    if (stripH) drawAudioStrip(img.buffer, img.width, img.height, height, audioOf(used[0], used[used.length - 1]));
    const png = encodePng(img.buffer, img.width, img.height, { level: 3 });
    // 占用率按**这张图上真有的格子**算：单箱时与 `p.area / p.bins` 完全等价
    const area = kept.reduce((acc, c) => acc + c.w * c.h, 0);

    // 队列深度：模型没跟上时丢最旧的 —— 宁可丢老画面，不给模型看十几秒前的事
    if (o.queueDepth > 0 && sheets.length >= o.queueDepth) sheets.shift();
    sheets.push({
      at: t,
      from: used[0].t,
      to: used[used.length - 1].t,
      png,
      w: img.width,
      h: img.height,
      fill: area,
      area,
      bins: 1,
      why,
      strip: img.stripH ?? 0,
      // 台词对齐用的墙上时间窗（epoch ms）。`from/to` 是相对秒，掉帧会漂；这两个不会。
      wallFrom: used[0].wall ?? null,
      wallTo: used[used.length - 1].wall ?? null,
      frames: used.map((f, i) => ({
        t: +f.t.toFixed(2), tier: seq[i], level: f.level, via: f.via, wall: f.wall ?? null,
      })),
      cells: rects.map((r) => ({ px: r.px, py: r.py, pw: r.pw, ph: r.ph, tier: r.t })),
    });
    stats.sheets += 1;
    noteChange(sheets[sheets.length - 1], used);
    return sheets[sheets.length - 1];
  }

  /**
   * 出图时的真实档位序列：**在这里**才应用假切点加成。
   *
   * 为什么拖到这一步：加成该不该生效取决于"这张图最后有几帧"，而 `keep()` 那一刻
   * 根本不知道后面还会不会来帧。帧少时压档只会把画布压空（实测 fill 94% → 63%），
   * 帧多时压档才真的省 token（每张固定 216，5 帧比 4 帧便宜 26%）。
   */
  function seqOf(batch) {
    /**
     * **按重要性分配面积**（`tierMode:'weight'`）—— 这才是"尺寸 = 重要性"的正解。
     *
     * 模型没有瞬时视觉，格子大小是唯一能告诉它"这一刻值不值得端详"的通道。但面积是零和
     * 的（Σ 1/k² ≤ 1），所以不能给"重要的帧"无条件大格 —— 只能把这一张图的总面积
     * **按权重切开**：
     *
     *     area_i ∝ weight_i        k_i = ceil(1 / sqrt(area_i))，再夹到 1..8
     *
     * 取 `ceil` 而不是 `round`：宁可小半档，也不能让 Σ 1/k² 超过 1（超了包不下）。
     * 权重用 `score`（这一帧比上一帧变了多少）—— 变化越大越是"一幕"，越值得占地方。
     * 帧多的时候每份面积自然变小，所以张数多寡仍然自动生效，不需要另立密度判据。
     *
     * **积分帧 / 兜底帧要折进权重里**：它们本来就不是"一幕"，是"这一段一直在变"或
     * "实在没东西可看"的采样。行式那套是用 `markBoost` 压档表达的，这里换成把权重打下去
     * —— 同一个意思，只是表达在面积上而不是档位上。不折的话游戏素材会多花 29% 的 token
     * （实测：同样 60 秒，7 张 → 9 张）。
     */
    if (o.tierMode === 'weight') {
      const on = batch.length >= Math.max(1, Number(o.boostMinFrames) || 4);
      const dampen = (via) => {
        if (!on) return 1;
        if (via === 'mark') return 1 / (1 + Math.max(0, Number(o.markBoost) || 0));
        if (via === 'floor') return 1 / (1 + Math.max(0, Number(o.floorBoost) || 0));
        return 1;
      };
      const w = batch.map((f) => {
        const s = Number(f.score);
        const base = Number.isFinite(s) && s > 0 ? s : 4;
        return Math.max(0.5, base * dampen(f.via));
      });
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      return batch.map((f, i) => {
        const area = Math.max(w[i] / sum, 1e-6);
        const k = Math.ceil(1 / Math.sqrt(area));
        return applyStrategy([Math.min(8, Math.max(1, k))], o.strategy, o.tierMap)[0];
      });
    }
    const on = batch.length >= Math.max(1, Number(o.boostMinFrames) || 4);
    // `Number(raw) || 0` 不是多余的：命令行 `--markBoost=0` 传进来是字符串 "0"，
    // `lv + "0"` 会变成 "10" 再被 clamp 成 8 档（实测把整张图打成 64 格碎格）。
    const boostFor = (via) => {
      if (!on) return 0;
      const raw = via === 'mark' ? o.markBoost : via === 'floor' ? o.floorBoost : 0;
      return Math.max(0, Number(raw) || 0);
    };
    return batch.map((f) => applyStrategy([Math.min(8, f.level + boostFor(f.via))], o.strategy, o.tierMap)[0]);
  }

  /** 停住的大面积前景：外圈还是旧背景，且背景变化不到整片。 */
  function stillForeground(entry) {
    const guardY = entry.guardY ?? entry.activeY ?? 0;
    if (!entry.futureModel
      || !(guardY >= 0.25)
      || entry.bg === null
      || entry.bg <= 0
      || entry.bg >= 220) return false;
    const border = bgBorderChanged(entry.futureModel, entry.hsv, guardY);
    return border !== null && border.score < o.cutFutureBorderMax;
  }

  /**
   * 低/中分但背景还有一块没被换掉、外圈也没动：可能是大手/产品挡住，也可能是真切。
   *
   * `cutFutureLowBgMax <= 0` 整条关闭低分未来帧确认。
   * 之前它只关低 bg 分支 —— 下面 `highBg`（bg 很高但稳定背景极少）是个独立出口，
   * 排在 `bg >= cutFutureLowBgMax` 之外，所以设 0 关不掉它。
   * 参数名叫 `...Max`、文档写"0 = 关闭"，实际留着一条路进来，是语义漏洞（issue #21 第 3 条）。
   * 高分路径（`score >= cutFutureMinScore`）不受影响，仍由 `cutFutureDelay` 管。
   */
  function lowAmbiguousFuture(entry) {
    if (o.cutFutureDelay <= 0
      || o.cutBgAbs <= 0
      || o.cutFutureLowBgMax <= 0
      || entry.score === null
      || entry.score >= o.cutFutureMinScore
      || !entry.futureModel
      || entry.bg === null
      || entry.bg <= 0
      || (entry.bgStable ?? 0) > o.cutFutureLowStableMax) return false;
    const stable = entry.bgStable ?? 0;
    const highBg = entry.bg >= o.cutFutureLowBgHigh && stable <= o.cutFutureLowStableTight;
    if (entry.bg >= o.cutFutureLowBgMax && !highBg) return false;
    const guardY = entry.guardY ?? entry.activeY ?? 0;
    if (!(guardY >= 0.25)) return false;
    // 外圈也被改变：可能是整屏前景，也可能是真切；只对这种情况做未来确认。
    const border = bgBorderChanged(entry.futureModel, entry.hsv, guardY);
    return border !== null && border.score >= o.cutFutureLowBorderMin;
  }

  function decide(entry, nextScore, nextMc = null, future = null) {
    const s = entry.score;
    if (s === null) { keep(entry, 'start'); return; }

    const px = entry.prev ?? 0;
    const nx = nextScore ?? 0;
    const base = Math.max(1, px, nx);
    const mcOkForSpike = o.cutMcAbs <= 0 || o.cutSpikeMcAbs <= 0
      || (entry.mc ?? 0) >= o.cutSpikeMcAbs;
    const spike = nextScore === null
      || (s > o.cutSpike * base && s >= o.cutSpikeAbs && mcOkForSpike);
    // 运动中的切机位：前后都在动时 spike 的 2.5 倍凑不出来，改用“台阶”
    const jump = s - base;
    const step = o.cutJumpAbs > 0
      && s >= o.cutAbs
      && s >= o.cutJumpAbs
      && jump >= o.cutJumpMargin
      && s >= o.cutJumpRatio * base;
    // 运动补偿：整屏在动但邻域里找得到对应 → 运镜；找不到对应 → 换镜头。
    // 半径 4 的 mc 比“绝对台阶”更直接：真实运动切机位 abs 只有 23 也能过。
    const mc = entry.mc ?? 0;
    const mcBox = entry.mcBox ?? 0;
    const mcFill = entry.mcFill ?? 0;
    const mcCut = o.cutMcAbs > 0
      && s >= o.cutMcMinScore
      && mc >= o.cutMcAbs;
    // 相似构图/相似主体的弱切点：低于 cutAbs，但几乎孤立
    const isolated = o.cutIsolatedAbs > 0
      && nextScore !== null
      && (o.cutMcAbs <= 0 || nextMc === null || nextMc < o.cutMcAbs)
      && (o.cutIsolatedMcAbs <= 0 || mc >= o.cutIsolatedMcAbs)
      && (o.cutIsolatedMcBBox <= 0 || mcBox >= o.cutIsolatedMcBBox)
      && (o.cutIsolatedFill <= 0 || mcFill >= o.cutIsolatedFill)
      && s >= o.cutIsolatedAbs
      && s < o.cutAbs
      && s > o.cutIsolatedSpike * base;
    // 前景运动不是切镜头：稳定背景大部分还在，且变化区域没盖满高度。
    // 只看低/中分事件；孤立弱切点另有区域门槛，不在这里误伤。
    const bg = entry.bg;
    const guardY = entry.guardY ?? entry.activeY ?? 0;
    const fgMotion = o.cutBgAbs > 0
      && s < o.cutBgMaxScore
      && !isolated
      && (o.cutBgMinCells <= 0 || (entry.bgStable ?? 0) >= o.cutBgMinCells)
      && bg !== null
      && bg > 0
      && bg < o.cutBgAbs
      && (o.cutBgMaxChanged <= 0 || (entry.bgChanged ?? 0) <= o.cutBgMaxChanged)
      && guardY >= 0.25
      && (o.cutBgMaxSpanY <= 0
        || (guardY > 0
          ? (entry.mcSpanY ?? 1) / guardY
          : (entry.mcSpanY ?? 1)) < o.cutBgMaxSpanY);
    // 高分候选不能只靠当前帧：等 0.5 秒，看候选帧改掉的稳定背景有没有回来。
    // 大面积前景运动离开/移开 -> keep 低；真正换镜头 -> 新场景还在，keep 高。
    let futureFg = false;
    const lowFuture = lowAmbiguousFuture(entry);
    if (o.cutFutureDelay > 0
      && entry.futureModel
      && (s >= o.cutFutureMinScore || lowFuture)) {
      const fk = future && future.hsv
        ? bgKeep(entry.futureModel, entry.hsv, future.hsv)
        : null;
      const rk = entry.prevHsv
        ? bgKeep(entry.futureModel, entry.prevHsv, entry.hsv)
        : null;
      const keepLimit = lowFuture
        ? ((entry.bgStable ?? 0) <= o.cutFutureLowStableTight
          ? o.cutFutureLowKeepTight : o.cutFutureLowKeep)
        : o.cutFutureKeep;
      const gone = (r) => r && r.score !== null
        && r.changed >= o.cutFutureMinChanged
        && r.score < keepLimit;
      // 前景停住时外圈通常还是旧背景：背景变化不算整片，外圈几乎没动，
      // 就不要等未来帧回来。真正换镜头 bg 很高，不会被这条挡住。
      futureFg = gone(fk)
        || (!lowFuture && gone(rk))
        || (s >= o.cutFutureMinScore && stillForeground(entry));
    }
    if (entry.t - lastCut >= o.cutMinGap
      && !fgMotion
      && !futureFg
      && (mcCut || (s >= o.cutAbs && (spike || step)) || isolated)) {
      lastCut = entry.t;
      acc = 0;                      // 切点之后重新攒（那一帧的分属于跨刀，不算运动）
      keep(entry, 'cut');
      return;
    }

    acc += s;
    if (acc >= integralNeed() && entry.t - lastBound >= o.markMinGap) {
      // 只有**真的录进去**才清零。被去重挡掉时保留累积值 —— 否则这一段的运动量
      // 白攒了，下一个采样点要重新等一整轮（实测会让出帧间隔凭空翻倍）。
      if (keep(entry, 'mark')) acc = 0;
      return;
    }
    let floorSec = o.silentFloorSec;
    if (o.floorGapK > 0 && gapEwma > 0) {
      floorSec = Math.min(o.floorMax, Math.max(o.floorMin, o.floorGapK * gapEwma));
    }
    if (entry.t - lastBound >= floorSec) keep(entry, 'floor');
  }

  return {
    /** 喂一帧。`buf` 必须是 width*height*3 的 rgb24。 */
    push({ t, buf }) {
      stats.frames += 1;
      tiers.tick(t);
      const r = scorer(buf);
      const s = r.score;
      if (s !== null) { stats.scoreSum += s; stats.scoreN += 1; if (s > stats.scoreMax) stats.scoreMax = s; }
      // `wall` 是这一帧被处理时的墙上时间（epoch ms）。台词（ASR）只有时间码没有帧号，
      // 对齐只能靠同一个时钟 —— `t` 是"第几秒"，掉帧就漂，不能拿来对字幕。
      const entry = {
        t, buf, score: s, raw: r.rawScore, gain: r.gain, bar: r.barFrac, mc: r.mcScore, mcBox: r.mcBox, mcRect: r.mcRect, mcFill: r.mcFill, mcSpanY: r.mcSpanY, activeY: r.activeY, guardY: r.guardY, bg: r.bgScore, bgStable: r.bgStable, bgChanged: r.bgChanged, bgModel: r.bgModel, futureModel: r.futureModel, prevHsv: r.prevHsv, prev: lastScore, hsv: Float32Array.from(r.hsv), wall: Date.now(),
      };
      lastSeen = entry;
      lastScore = s;
      q.push(entry);
      while (q.length >= 2) {
        const front = q[0];
        if (front.score === null) {
          decide(front, q[1].score, q[1].mc, null);
          q.shift();
          continue;
        }
        const needFuture = o.cutFutureDelay > 0
          && ((front.score >= o.cutFutureMinScore && !stillForeground(front))
            || lowAmbiguousFuture(front));
        const future = o.cutFutureDelay > 0
          ? q.find((e) => e !== front && e.t - front.t >= o.cutFutureDelay) ?? null
          : null;
        if (needFuture && !future) break;
        decide(front, q[1].score, q[1].mc, future);
        q.shift();
      }
    },

    /** 流结束：把还剩的那一帧判掉，再把最后一张发出去。 */
    finish() {
      while (q.length) {
        const front = q[0];
        const future = o.cutFutureDelay > 0
          ? q.find((e) => e !== front && e.t - front.t >= o.cutFutureDelay) ?? null
          : null;
        decide(front, q.length > 1 ? q[1].score : null, q.length > 1 ? q[1].mc : null, future);
        q.shift();
      }
      // 收尾这批也要**一段一箱**：多箱多半出现在最后（帧都攒在尾部），
      // 直接发就会把两箱画到一张画布上。
      let guard = 0;
      while (frames.length && guard < 64) {
        guard += 1;
        const segs = splitOneBin(seqOf(frames), { binCost: o.binCost, packMode: o.packMode });
        if (segs.length <= 1) { flush(lastBound, 'end'); break; }
        const keep = segs[0].length;
        const carry = frames.slice(keep);
        frames = frames.slice(0, keep);
        flush(frames[frames.length - 1].t, 'end');
        frames = carry;
      }
      return { stats, sheets };
    },

    /**
     * **立刻截断出图**。用户插话走这条：不等判据，也不排队。
     *
     * 本张是空的（刚发完）就把「最近解出来的那一帧」塞进去 —— 用户问的是现在屏幕上是什么，
     * 给一张空图或者十几秒前的图都不对。
     *
     * @returns {object|null} 这一张（同时清空队列，插话永远拿最新的）
     */
    flushNow(t = null, why = 'user') {
      // **永远把「此刻那一帧」补进去**，不只是本张为空时。
      // 用户问的是"现在屏幕上是什么"，只给他攒了半张的旧帧不对（实测插话在 30s，
      // 图里最后一帧是 26.5s，差了三秒多）。
      if (lastSeen && (!frames.length || lastSeen.t > frames[frames.length - 1].t + 1e-6)) {
        const lv = tiers.levelAt();
        tiers.mark(lastSeen.t);
        if (!frames.length) sheetStart = lastSeen.t;
        frames.push({
          t: lastSeen.t, buf: lastSeen.buf, via: why === 'user' ? 'user' : 'now', level: lv,
          tier: applyStrategy([lv], o.strategy, o.tierMap)[0],
          // 「此刻那一帧」也要带 wall —— 漏了它，`sheet.wallTo` 会是 null，
          // 台词就按 `Date.now()` 兜底，时间窗对不上（实测最后一张的台词取不到）
          wall: lastSeen.wall ?? Date.now(),
        });
      }
      // 装不下就从**最老的**开始丢：插话要的是最新画面，老的让位
      if (regionAspect) {
        // region 模式没有"装箱"这回事（一帧一格），只按硬上限截断。
        // **不能调 plan()**：`plan()` 是 pack 的 DP，在 region 模式下算出来的
        // bins 没有意义，误判会白丢帧。
        const cap = Math.max(1, Number(o.maxFrames) || 4);
        while (frames.length > cap) {
          frames.shift();
          sheetStart = frames[0].t;
        }
      } else {
        while (frames.length > 1 && plan().bins > 1) {
          frames.shift();
          sheetStart = frames[0].t;
        }
      }
      if (!frames.length) return null;
      const at = t ?? frames[frames.length - 1].t;
      const made = flush(at, why);
      sheets.length = 0;
      return made ?? null;
    },

    /** 取走队列里最老的一张（阻塞语义由调用方实现）。 */
    take() {
      return sheets.shift() ?? null;
    },

    /**
     * 把一张**刚取出来、还没交付**的图放回队首。
     *
     * 为什么需要它：`take()` 是"取走即清"。取出来之后如果"交付"这件事没成 ——
     * 叫醒失败（会话没了、宿主不接）—— 这张图就凭空消失了，用户看到的是
     * "它说有新画面，然后什么都没发生"。留一条放回去的路，才不会自己弄丢图。
     *
     * `queueDepth > 0` 且队列已经满了就**不放**：队列里那张更新，按 `queueDepth`
     * 的设计宁可丢老画面（"不给模型看十几秒前的事"）。返回值告诉调用方放没放成。
     */
    restore(sheet) {
      if (!sheet) return false;
      if (o.queueDepth > 0 && sheets.length >= o.queueDepth) return false;
      sheets.unshift(sheet);
      return true;
    },

    /**
     * 取走自上次交付以来的变化摘要并清空（见 `noteChange`）。
     * 没开 `changeLog` 时永远是空数组 —— 调用方不用关心开关。
     */
    drainChanges() {
      const out = changes.slice();
      changes.length = 0;
      return out;
    },

    peek() {
      return sheets[0] ?? null;
    },

    /** 手上有没有"最近解出来的那一帧"（插话时先看这个，别急着给空手） */
    get hasFrame() { return lastSeen !== null; },

    /** 本批第一帧到现在多久（唤醒文案要说"这段时间有多长"） */
    get secondsSinceWake() {
      if (!frames.length || lastSeen === null) return null;
      return +(lastSeen.t - sheetStart).toFixed(1);
    },

    get pending() { return sheets.length; },
    get log() { return log; },
    get stats() { return stats; },
    get tiers() { return tiers; },
    constants: o,
  };
}
