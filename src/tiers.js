/**
 * tiers.js — 档位：这一帧该占多大格子。**因果版**，照 docx 的算法（卷积 → 平滑 → 7 阈值 + 滞回 → 1..8）。
 *
 * ## 与 docx / storyboard 0.6.0 的三处换算
 *
 * docx 写死了三件事：`dt = 100 帧`、阈值是「**每帧**碰上切点的概率」、默认 30fps。
 * 三者是绑死的，单独改 dt 会让整套阈值失效：
 *
 *   dt=100 帧、30fps → 窗宽 3.33s；阈值 0.0085 = 每 118 帧一刀
 *   dt=12 帧、12fps  → 窗宽 1s；    一刀就是 1/12 = 0.083，**一步跨过 5 道阈值**
 *
 * 所以阈值整体换成 **「帧/秒」**（= 原表 × 30），跟 fps 脱钩，dt 才真的变成「看过去几秒」：
 *
 *   [0.26, 0.6, 0.9, 1.2, 1.8, 2.4, 3.0] 帧/秒  ≈ 3.9s / 1.7 / 1.1 / 0.83 / 0.56 / 0.42 / 0.33 一帧
 *
 * ## 密度数的是什么
 *
 * storyboard 只数**真切点**，因为批量场景里「帧 = 镜头」。实时场景里一镜到底的素材
 * 一个真切点都没有，只数切点会让档位永远停在 1 档 —— 而积分帧照样往外冒。
 * 所以这里数的是**所有边界**（切点 + 积分帧 + 兜底帧），也就是「每秒留下几帧」，
 * 它跟「一张图能放几格」是同一件事：
 *
 *   档 k 的格子占比 1/k²，一张图放 k² 格 → 每秒 F 帧时，一张图覆盖 k²/F 秒
 *   k ≈ sqrt(T·F)，取 T≈16s：F=0.25 → k=2；F=1 → k=4；F=4 → k=8
 *
 * 正好落在上面那张阈值表上 —— 这不是巧合，docx 的阈值本来就是按「每秒几刀」标的。
 *
 * ## 两处因果化（批量版都用了未来）
 *
 * - 密度窗：居中 `[t-dt/2, t+dt/2]` → **只看过去** `[t-dt, t]`
 * - 平滑：`movmean(50 帧)` → 每帧走一步的一阶 EMA
 *
 * `tick(t)` 必须**每帧都调**（12 次/秒），不能只在留帧时调 —— 只在留帧时调的话
 * EMA 的步长跟着留帧间隔走，两帧留得远就一步跳满，密度会瞬间冲顶。
 */

/** 帧/秒。docx 的 7 道阈值 × 30fps。 */
export const LEVEL_THRESHOLDS = Object.freeze([0.26, 0.6, 0.9, 1.2, 1.8, 2.4, 3.0]);

/**
 * 感知档位阈值 —— 用「人眼瞬时记忆 / 主观现在」的实测时长当端点重排的 7 道。
 *
 * 阈值在这里的实际含义是 **一格代表着多少秒画面**（一格覆盖 `1/F` 秒）。所以两端各有一个
 * 感知上的界：
 *
 * - **下界 3.0 s → F=0.333**：Pöppel 的"主观现在"实测 2~3 s（跨视觉/听觉/言语/运动多范式），
 *   Fraisse 汇总的心理现在 2~3 s；**电影的镜头时长本身就有 ~3 s 的偏好**。一格超过 3 秒，
 *   等于把一整个"现在"压成一张图。
 * - **上界 0.30 s → F=3.333**：注意眨眼（AB）在 200~500 ms，第二目标落在这个窗口里就看不见；
 *   图标记忆的部分报告优势在 250~500 ms 内消失（Sperling 1960）；可用的变化检测窗口只有
 *   ~120 ms、"报告"约 190 ms、"静态检测"≥240 ms。**两条边界比 300 ms 还近，人眼就当成一次变化**，
 *   再多留帧只是白花代价。
 *
 * 中间六道按**等比**排（时长辨别服从 Weber 律，等比对等距更贴近感知）：
 * `r = (3.333/0.333)^(1/6) = 1.4678`，于是每格代表
 * `3.00 / 2.04 / 1.39 / 0.95 / 0.65 / 0.44 / 0.30` 秒。
 *
 * 注意端点都往里收了：旧的 0.26（3.9 s）比"现在"还长，旧的 3.0 又比 300 ms 的界刚好卡齐。
 * 中间比旧表更低 —— 同样的密度会更早进小格子（每张塞更多帧、单帧更小）。
 *
 * 用 `tierCurve: 'perceptual'` 打开；默认仍是 `docx`。
 */
export const PERCEPTUAL_THRESHOLDS = Object.freeze([0.333, 0.489, 0.718, 1.054, 1.547, 2.271, 3.333]);

/** 可选的阈值表。改默认值之前先看 `scripts/sim.mjs` 的对比数据。 */
export const TIER_CURVES = Object.freeze({
  docx: LEVEL_THRESHOLDS,
  perceptual: PERCEPTUAL_THRESHOLDS,
});

/**
 * **这里删掉过一种分配方式**（`tierMode: 'dwell'`：按"这一段在屏幕上停了多久"给尺寸，
 * 端点是 3 s / 0.3 s、中间等比，与 `PERCEPTUAL_THRESHOLDS` 互为倒数）。
 *
 * 删掉的原因有数据（五段素材跑了 A/B，**零次胜出**）：
 *
 * | 素材 | density | dwell |
 * |---|---|---|
 * | base（14 s，7 刀） | 2 张 / fill 100% | 3 张 / fill 51.1% |
 * | dark-jian | 5 张 / fill 90.5% | 4 张 / fill 74.3% |
 * | 讲课（无切点） | 2 张 / 75% | 完全相同 |
 * | 游戏（60 s） | 平均 4.56 档 | 平均 7.28 档，100 帧里 **64 帧落 8 档** |
 *
 * 根因不是"停留时长这个信号不好"，是**我们量错了对象**：采样间隔由我们自己定
 * （积分帧、兜底帧把节奏压平到 0.5~0.6 s），所以"两次**采样**之间隔多久"几乎不携带
 * 内容信息。真要用这个信号，得量"两次**真切点**之间的时长" —— 那是另一件事，
 * 别在原地上重试。
 */

export const HYSTERESIS = 0.05;
export const TIER_MIN = 1;
export const TIER_MAX = 8;

/**
 * 实时只用三个策略（storyboard 的 standard「1 档压成 1/2」在实时里等于单帧永远不给整幅，
 * 静态画面白扔 75% 画布，所以不要它）：
 */
export const STRATEGIES = Object.freeze({
  native: { bump: 0, label: '原生' },
  /**
   * **标准**：1 档压成 1/2（`floor: 2`），其余档位不动。
   *
   * 以前实时这边特意不要它（注释原话："在实时里等于单帧永远不给整幅，静态画面白扔 75% 画布"）。
   * 但实测下来"一格占满"的场景很少：大多数片子 1 档是"几乎没变"的那几帧，
   * 让它们占满整张图反而一张只放一帧、张数爆炸。所以改成默认压一档。
   *
   * 想要"1 档也占满整幅"就选「原生」（不压），逐帧模式仍然强制整幅（`single`）。
   */
  standard: { bump: 0, floor: 2, label: '标准' },
  full: { bump: -1, floor: 1, label: '更大' },
  compact: { bump: 1, label: '更小' },
  /**
   * **逐帧模式**专用：不管密度多高，每一帧都占满整张画布。
   *
   * 密度档位是为"一张图塞多帧"设计的 —— 帧越密格子越小。但逐场景播报要的是
   * "一张图 = 一个画面"，格子必须撑满，否则一帧只占 1/4 或 1/9，中间全是灰条。
   * 0（自由尺寸的补位帧）原样保留。
   */
  single: { fixed: 1, label: '整幅' },
});

/**
 * 逐档查表：档位 1..8 → 目标档位。
 *
 * 表里的坏值（非数字、越界）**逐项忽略，保留原档位** —— 一份手改坏的
 * `tierMap` 不该把整个画面搞崩，最多是那几档没按预期排。
 */
function applyTierMap(tiers, map) {
  const table = Array.isArray(map) ? map : null;
  if (!table) return tiers.map((t) => Number(t));
  return tiers.map((t) => {
    const n = Number(t);
    // 0 = 自由尺寸的补位帧，不参与映射（它本来就"占剩下的地方"）
    if (!Number.isFinite(n) || n === 0) return n;
    const idx = Math.max(TIER_MIN, Math.min(TIER_MAX, Math.round(n))) - 1;
    const v = Number(table[idx]);
    return Number.isFinite(v) ? Math.max(TIER_MIN, Math.min(TIER_MAX, Math.round(v))) : n;
  });
}

/**
 * 档位映射。
 *
 * @param {number[]} tiers 原始档位（1..8，0 = 自由尺寸补位帧）
 * @param {string} strategy `native` / `full` / `compact` / `single` / **`custom`**
 * @param {number[]|null} map 只在 `custom` 时用：8 个数，第 i 个是"档位 i+1 映射到哪一档"
 */
export function applyStrategy(tiers, strategy = 'native', map = null) {
  if (strategy === 'custom') return applyTierMap(tiers, map);
  const s = STRATEGIES[strategy] ?? STRATEGIES.native;
  // 固定档：不管原来算出来是几档，全部压到同一档
  if (s.fixed) return tiers.map((t) => (Number(t) === 0 ? 0 : s.fixed));
  return tiers.map((t) => {
    let v = t + s.bump;
    if (s.floor) v = Math.max(s.floor, v);
    return Math.max(TIER_MIN, Math.min(TIER_MAX, v));
  });
}

/** 默认映射：恒等（档位 i → i）。设置页"自定义"的初始值就是这个。 */
export const DEFAULT_TIER_MAP = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);

export function createTiers({
  fps = 12, dtFrames = 12, smoothFrames = 6,
  curve = 'docx', thresholds, hysteresis = HYSTERESIS,
} = {}) {
  const table = thresholds ?? TIER_CURVES[curve] ?? LEVEL_THRESHOLDS;
  const W = Math.max(1, dtFrames) / fps;             // 密度窗（秒）
  const alpha = 1 / Math.max(1, smoothFrames);       // 每帧一步的 EMA 系数
  const up = table.map((v) => v * (1 + hysteresis));
  const down = table.map((v) => v * (1 - hysteresis));

  const bounds = [];      // 已留下的帧的时刻（秒）
  let smoothed = 0;
  let level = 1;

  const countAtLeast = (val, arr) => {
    let k = 0;
    for (let i = 0; i < arr.length; i += 1) if (val >= arr[i]) k += 1;
    return k;
  };

  return {
    /** 记一个边界（帧被留下的时刻）。 */
    mark(t) {
      bounds.push(t);
    },

    /** 每帧调一次：更新密度与档位。**不含当前帧**（它还没被 mark）。 */
    tick(t) {
      const lo = t - W;
      let i = bounds.length - 1;
      let n = 0;
      while (i >= 0 && bounds[i] > lo) { n += 1; i -= 1; }
      const raw = n / W;
      smoothed += (raw - smoothed) * alpha;

      const val = smoothed;
      if (level < TIER_MAX && val > up[level - 1]) {
        level = 1 + countAtLeast(val, up);
      } else if (level > TIER_MIN && val < down[level - 2]) {
        level = 1 + countAtLeast(val, down);
      }
      level = Math.max(TIER_MIN, Math.min(TIER_MAX, level));

      // 窗口外的边界再也用不到（多留 1s 余量），别让数组无限长
      if (i > 64) bounds.splice(0, i - 1);
      return level;
    },

    levelAt() { return level; },

    get density() { return smoothed; },
    get bounds() { return bounds; },
    get widthSec() { return W; },
  };
}
