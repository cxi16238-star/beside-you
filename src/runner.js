/**
 * runner.js — 常驻采集会话：start / watch / peek / stop。
 *
 * 和 pipeline.js 的分工：pipeline 只管「帧进、图出」，不碰进程；这里管**进程生命周期**
 * 和**取图语义**（阻塞到有图 / 立刻要 / 保持温热）。
 *
 * ## 三条刻意的设计
 *
 * ① **出图由采集侧自己攒、自己截**（pipeline 里做），`watch` 只是"取队列里那一张"。
 *    所以模型思考三秒不是延迟，只是让队列多一张。
 *
 * ② **停采集要留宽限期**。冷启动一次 400ms（屏幕）/ 1.7s（摄像头硬件唤醒），
 *    每次 watch 都停掉的话，连续看就是每次重付这笔钱。所以看完留 `graceSec` 秒，
 *    期间再来 watch 立刻就有帧；超时没人来才自己收工。
 *
 * ③ **取图永远走队列，不新建**。两张图同时在飞的时候，`take()` 给的是最早那张
 *    （时间顺序不能乱），新图挤掉旧图由 pipeline 的 queueDepth 负责。
 */

import { spawnFrames, pickScreenEngine, screenEngineWarning } from './capture.js';
import { spawnPortalFrames, resolvePython } from './portal-capture.js';
import { startIndicator, stopIndicator, indicatorState } from './indicator.js';
import { createPipeline } from './pipeline.js';
import { cellSize } from './layout.js';
import { chatWatcherShared, enterChatWait } from './chat.js';
import { saveStreamSize } from './region.js';
import { noteInterjected } from './interject.js';
import { openWindow, pidStamp, windowAlive, setWindowHidden, sendWindowState } from './window.js';
import { createListener } from './listen.js';

/**
 * 四档清晰度。数字是画布像素（**不含**底部音轨条），实际 token 见 src/tokens.js。
 *
 * **宽度全部向下对齐到 42**（800→798、1066→1050…）。原因和 storyboard 那边一样：
 * 800 会被 pad 到 812 = 19.3 格，白白多算一整列（20 列）；798 正好 19 列，
 * 面积只少 0.25%，token 每张省 11~24。这是整个插件里唯一**零代价**的降本点。
 *
 * **音轨条不额外收费**：条高取"这一档画面本来就没占满的那点行余量"
 * （450 高占 11 行、上界 462，白空 12px）—— 见 `sheet.js` 的 `stripHeight()`。
 * 所以这里写的 token 就是**带条之后**的实价。
 */
export const SIZES = Object.freeze({
  low: [798, 450],        // 222 token/张（12px 条）· 4 帧时每格 399×225 —— 看视频/场景够
  standard: [1050, 600],  // 392 token/张（30px 条）· 每格 525×300 —— 屏幕上的中号字能认
  high: [1260, 720],      // 560 token/张（36px 条）· 每格 630×360 —— 文件名/小字能认
  ultra: [1596, 900],     // 860 token/张（24px 条）· 单帧时几乎等于原屏 —— 真要读字才用
});
export const DEFAULT_QUALITY = 'low';

/**
 * 档位长边（`region` 模式用）。
 *
 * 为什么单独列一张表，而不是继续读 `SIZES[q][0]`：region 模式下 `width/height`
 * 的语义变成**单格**尺寸，只有长边才对应档位；`SIZES` 里的 798×450 是整张画布的
 * 尺寸（16:9），两者不能混用。
 *
 * **故意不跟着 42 对齐**：整屏模式对齐是因为画布一定被 pad 到 42 的整数倍；
 * region 的格子是 `cellSize()` 按区域比例算出来的（竖屏 9:16 → 800×450），
 * 本来就不是 42 的倍数，改了只会连带 2/4 帧拼图的尺寸，收益是个位数 token。
 */
export const LONG_EDGE = Object.freeze({
  low: 800, standard: 1066, high: 1280, ultra: 1600,
});

/**
 * 「逐帧 / 逐场景」模式的管线参数。
 *
 * - `maxFrames: 1` —— 留下 1 帧就立刻封箱（`checkFlush` 的 `frames.length >= maxFrames`），
 *   所以一张图永远只有一个画面。
 * - `strategy: 'single'` —— 档位固定压到 1，让这一帧**铺满整张画布**。
 *   不压的话，场景密集时密度档位会升到 2/3，一格只占 1/4、1/9，中间全是灰条。
 *
 * 这两个必须成对出现：只改 maxFrames 会得到"小格子 + 大片留白"，只改 strategy
 * 会得到"一张图里好几幅满幅图，装不下就被切开"。
 */
export const SCENE_OPTS = Object.freeze({ maxFrames: 1, strategy: 'single' });

/**
 * 三档节奏。**只影响"多久算一次画面变了"和"多久叫醒一次"**，不改出图口径。
 *
 * 为什么要有它：`cutAbs` 是全局常量，模型听见"省点钱"也只能嘴上答应 ——
 * 频率完全由插件定。用户实报"回复太密集"，说明缺一个能让这句话生效的旋钮。
 *
 * | 档 | cutAbs | 唤醒间隔 | 适合 |
 * |---|---|---|---|
 * | calm | 20 | 30s | 日常挂着看，只想知道"大场面变了没" |
 * | normal | 12 | 15s | 默认。滚网页/切窗口不会每下都留帧 |
 * | dense | 7 | 8s | 幻灯片、逐帧播报这种"每一刀都要"的 |
 * | game-economic | 80 | 20s | 全屏游戏 / 高速运动。靠 `pipeline` 把积分阈值也一起抬高 |
 *
 * 7 是能给的最低值（再低只有"只改亮度"那种肉眼都看不出的变化），
 * 但它对日常屏幕太敏感 —— 光标一停、窗口一换都能过线，所以不做默认。
 *
 * 80 看着离谱，其实是被内容逼的：动作游戏里每帧都有大位移，正常切点淹没在运动里。
 * 这一档同时把积分阈值从 144 抬到 1440（`integralSeconds` 3 → 30），
 * 否则"改画面"的门槛抬了、出帧密度却没降，还是会被叫到贴限速。
 */
export const PACES = Object.freeze({
  // 三档都带自适应兜底（`floorGapK`）：兜底间隔 = k × 近期出帧间隔，夹在 [floorMin, floorMax]。
  // 越省电的档兜底越长（calm k=3 / normal k=2 / dense k=1.2），因为省电档宁可漏也不要多。
  // normal 取 2 而不是 1.5：实测覆盖率 64.2→67.4（SHOT）/ 89.1→94.2（BBC），帧数只 +8~10%；
  // 1.5 能到 70.4 / 97.5，但 BBC 上每多 1 个点要花 83 帧（k=2 只要 47），是为最后几个点付溢价。
  // 想要全覆盖：给 normal 传 floorGapK: 1.5。
  // calm 刻意只抓大场面：关掉 6~20 分的弱切点，避免省电档反而变吵
  calm: { cutAbs: 20, wakeGapSec: 30, pipeline: { cutIsolatedAbs: 0, cutMcAbs: 0, floorGapK: 3, floorMin: 3, floorMax: 30 } },
  normal: { cutAbs: 12, wakeGapSec: 15, pipeline: { floorGapK: 2, floorMin: 2, floorMax: 20 } },
  dense: { cutAbs: 7, wakeGapSec: 8, pipeline: { floorGapK: 1.2, floorMin: 2, floorMax: 20 } },
  /**
   * 全屏动作游戏 / 高速运动画面（key 用 `game-economic`：目标就是"陪玩但别烧钱"）。
   *
   * 为什么需要单独一档：这类画面**每一帧都在动**，分数基线被抬高，切点门槛 12 等于"全是切点"，
   * 尖峰判据也救不回来（左右邻居同样高）。实测反馈（B 站用户「总在冬眠的熊」，打了一两个小时
   * 全屏动作游戏后自己调出来的值）：cutAbs 80、积分阈值约 1800、每张 6 帧、maxWait 120s，
   * 才从"顶着限速发请求 + 40 帧一张巨糊"变成"舒适"。
   *
   * 这里取比他**略保守**的一组（积分 1440 而不是 1800，每张 8 帧而不是 6），
   * 因为他的 40 帧/张是在 normal 档下被 maxWait 逼出来的，不是他真想要 6 帧。
   * `pipeline` 里的键会原样覆盖 `pipeline.js::DEFAULTS` 的同名项。
   */
  'game-economic': {
    cutAbs: 80,
    wakeGapSec: 20,
    pipeline: {
      integralSeconds: 30,
      maxFrames: 8,
      maxWaitSec: 60,
      silentFloorSec: 40,
      cutSpike: 1.5,
      cutSpikeAbs: 30,
      // 游戏画面每帧都在动：低分孤立 / 台阶 / mc 都会把运动误判成切点
      cutIsolatedAbs: 0,
      cutJumpAbs: 0,
      cutMcAbs: 0,
      floorGapK: 2,
      floorMin: 2,
      floorMax: 20,
    },
  },
});
export const DEFAULT_PACE = 'normal';

/** 参数签名：key 排序后拼串，`{a:1,b:2}` 与 `{b:2,a:1}` 视为同一个。 */
function optsSig(o) {
  return Object.keys(o ?? {}).sort().map((k) => `${k}=${JSON.stringify(o[k])}`).join('|');
}

/**
 * 「这一条 watch 该不该被硬闸拦下」的**纯函数**（好测，也好读）。
 *
 * 三条规矩：
 * - 用户关过窗（`hungUp`）→ 除非他显式说了要看什么，否则不重开。
 * - 文件放完了（`fileEnded`）→ 同上，文件回放是一次性的，不能自动重播。
 * - 显式传了来源 = 用户明确要求 → 一律放行。
 */
/**
 * 挂断之后该不该因为"窗被重新打开"而解除。
 *
 * **不能只看 `windowAlive()`**：残留进程（用户关了但进程没死、或者测试机上本来就有窗口）
 * 同样让它为 true，那样就会把窗重新弹出来 —— 正是社区实报的"关掉又弹出来"。
 * 判据必须是"pid 文件在挂断之后被**重写过**"，那才代表有人主动开了窗。
 */
export function resumeFromReopen({ hungUp = false, winAlive = false, pidNow = 0, pidAtHangUp = 0 } = {}) {
  return Boolean(hungUp && winAlive && pidNow > pidAtHangUp);
}

export function guardReason({ hungUp = false, fileEnded = false, explicitSrc = false } = {}) {
  if (explicitSrc) return null;
  if (hungUp) return 'hung-up';
  if (fileEnded) return 'file-ended';
  return null;
}

/**
 * 把候选台词**按 `t0` 归张**：一句话只跟它开始时刻所在的那一张走。
 *
 * 为什么需要它：取台词的窗口两头都留了余量（`from-400` / `to+800`，迟到转写不能丢），
 * 所以跨在边界上的那句话会**同时出现在相邻两张的候选里**。一张张交付时隔着两轮看不出来，
 * 一次交三张（超省模式）就是同一句在同一个结果里出现两次，第二份还被标成 `#1`。
 *
 * 规则：
 * - `t0` 落在哪张的窗口里（`from-400 .. to`）就归哪张 —— 跨界的那句归**更早**那张，
 *   因为它大半是在那张的画面里说的；
 * - 比第一张还早的迟到句（只靠 `-400` 捡回来的）归最先看到它的那张，不丢；
 * - 同一 `t0` 只挂一次。
 *
 * @param {{from:number,to:number}[]} windows  epoch ms，**按时间正序**
 * @param {Array<Array<{t0:number,t1:number,text:string}>>} candidates  每张的候选（窗口带余量）
 * @returns {Array<Array<object>>} 每张该挂的台词，按 `t0` 升序
 */
export function bucketLines(windows, candidates) {
  const out = (windows ?? []).map(() => []);
  if (!out.length || !candidates?.length) return out;
  const seen = new Set();
  const ownerOf = (t0) => {
    for (let i = 0; i < windows.length; i += 1) {
      if (t0 <= windows[i].to && t0 >= windows[i].from - 400) return i;
    }
    return -1;
  };
  for (let i = 0; i < candidates.length; i += 1) {
    for (const l of candidates[i]) {
      if (seen.has(l.t0)) continue;
      const owner = ownerOf(l.t0);
      seen.add(l.t0);
      out[owner >= 0 ? owner : i].push(l);
    }
  }
  return out.map((lines) => lines.sort((a, b) => a.t0 - b.t0));
}

export function createRunner({
  ffmpegPath = 'ffmpeg', log = () => {}, graceSec = 60, ctx = null,
  /** 「听声音」的延迟参数（`~/.dsh/see-now.json` 的 `listen` 段，见 tuning.js） */
  listen = null,
  /** `~/.dsh/see-now.json` 的 `changeLog`：交付时附「这期间屏幕怎么动的」摘要（默认关） */
  changeLog = false,
  /**
   * 叫醒时预留的那张图最多留多久（秒）。
   *
   * 模型压根没 `peek`（比如它回了一句话就收工）时，预留不能被无限占着 ——
   * 否则下一次出图会被"旧的那张还在手里"顶掉，等于少给一张。60 秒够覆盖
   * "宿主冷启动 + 模型思考"的最坏情况，又远短于"用户已经不看这一屏了"。
   */
  reserveSec = 60,
  /**
   * 超省模式：攒够几张图才交给模型（`~/.dsh/see-now.json` 的 `wakeBatch`）。
   *
   * 两个地方用它：`queueDepth` 决定队列能压几张（压不住就等于没攒），
   * `takeSheets()` 决定一次最多交几张。**只改一个都不省**——攒了却一张张交，
   * 模型还是得一轮一轮来。
   */
  wakeBatch = 1,
  /**
   * 全局档位映射（`~/.dsh/see-now.json` 的 `tierStyle` / `tierMap`）。
   *
   * 只在**调用方没显式传** `opts.strategy` 时生效 —— 逐帧模式（`SCENE_OPTS`）必须
   * 把整幅写死，不能被用户设的"更小"打回 1/4 格子。
   */
  tierStyle = 'standard',
  tierMap = null,
  /**
   * 档位怎么算 + 七道阈值取哪一套（`~/.dsh/see-now.json` 的 `tierMode` / `tierCurve` /
   * `tierThresholds`）。和 `tierStyle` 一样是**会话级默认**，`opts` 里显式传了就听调用方的
   * —— 离线标定（`scripts/sim.mjs`）要能一次改一样，不必去动配置文件。
   */
  tierMode = 'density',
  tierCurve = 'docx',
  tierThresholds = null,
  /**
   * 亮度归一 + 黑边补偿（`~/.dsh/see-now.json` 的 `scoreNormalize`，默认开）。
   *
   * **必须进 `createPipeline` 的 opts，不能只在这里拦** —— `scripts/sim.mjs` 走的是
   * 管线本身，开关停在 runner 层的话离线就没法做 A/B，标定做不了。
   * 调用方显式传 `opts.scoreNormalize` 时以调用方为准（同 `tierStyle`）。
   */
  scoreNormalize = true,
} = {}) {
  let pipeline = null;   // 当前（或刚停的）引擎 —— 停采集后仍留着，好把队列里剩的图发完
  let running = false;
  let run = null;
  let source = null;
  let startedAt = 0;
  let frames = 0;
  let lastError = null;
  let stoppedAt = 0;
  let graceTimer = null;
  let busy = false;
  let quality = DEFAULT_QUALITY;

  /**
   * **叫醒时预留的那一张**（`{ sheet, at, seq }`）。
   *
   * ## 为什么必须有这一层
   *
   * 唤醒文案让模型"调 `peek` 拿这一张"，但一条链上有三个时间差：
   *
   * ```
   * loop 看到 pending=1 ──▶ reserveSheet() ──▶ wake() 1~3 秒 ──▶ 模型 peek
   *                          ↑ 图从这里开始就不在队列里了
   * ```
   *
   * 社区实报（0.0.8，逐场景 + dense，110 秒叫了 6 次）：**多数唤醒之后 peek 拿到空**。
   * 图确实出了（叫醒靠出图序号驱动），问题在"出图"和"取图"之间隔着 1~3 秒，
   * 这期间任何一条路径把队列取空（另一条 `watch`、`flushNow` 截断、换管线），
   * 模型醒了就是空手。
   *
   * 所以：**叫醒前先把这一张从队列里抢到手里**。抢出来之后：
   *   - `peek` 优先给预留的（`takeSheet`），不管队列被别人怎么折腾；
   *   - `watch` 也走同一个口（它要的本来就是"最早攒好的那张"）；
   *   - 叫醒失败就 `releaseSheet()` 放回队首 —— 不能因为叫不醒就把图弄丢。
   *
   * ⚠️ 这**不影响**"采集和打分从不停"：预留只是挪一张已经拼好的图，
   * 不参与采集、不触发采集、也不改变 `queueDepth`（队列里照样只留最新的一张）。
   */
  let reserved = null;

  /**
   * 取图记账：`peek` 取走几张、空了几次、其中几次是预留给的。
   *
   * 没有这三个数，"叫醒了却没图"只能靠猜（这次就是猜了三轮才定位到"图被别的路径取走了"）。
   * 它们出现在 `see_now({action:"status"})` 的 meta 里，下次复现直接看数。
   */
  const takes = { peek: 0, peekEmpty: 0, watch: 0, watchEmpty: 0, reserved: 0 };

  /**
   * 听声音（视频里在说什么）。**可选能力**：装不上（没有 pyaudiowpatch、没有转写服务、
   * 这台机器没有回环设备）就只是没字幕，看图一切照旧 —— 绝不能让"看屏幕"起不来。
   *
   * 为什么在 runner 里而不是在工具层：它的生命周期和采集是同一个 ——
   * 开始看就开听，收工就停，中途换清晰度/换 region 也不用重启（音频跟画面无关）。
   */
  const listener = createListener({ ctx, log, listen });
  /**
   * 上一张图的时间窗末尾（epoch ms）。台词按"上一张到现在"取，
   * 不能按这一张自己的 from/to —— 静止屏幕上两张之间隔 60 秒，中间说的话会整段漏掉。
   */
  let lastSheetWallTo = 0;

  /**
   * 把这段时间窗里的台词挂到 sheet 上。**没有台词就什么都不加** ——
   * 模型看到空的"台词："标题只会以为转写坏了。
   *
   * 单张交付走这里；一次交 N 张走 `attachSheets()`（多了一层"按 t0 归张"）。
   */
  function attachLines(sheet) {
    if (!sheet) return sheet;
    const to = sheet.wallTo ?? Date.now();
    /**
     * 第一张图是"此刻"（往往只有 1 帧），时间窗只有一个点 —— 直接照它取，
     * 用户第一眼永远看不到任何台词（那句话还没说完/还没转写）。
     * 所以首次往回多看 20 秒：反正缓冲里本来就只有这么久的东西。
     */
    const from = lastSheetWallTo || Math.min(sheet.wallFrom ?? to, to - 20_000);
    const got = listener.between(from - 400, to + 800);
    if (to > lastSheetWallTo) lastSheetWallTo = to;
    if (got.length) sheet.lines = got;
    /**
     * 变化日志：挂到这张图上，交付层拼进文本（见 index.js 的 `sheetText`）。
     * `drainChanges` 取走即清 —— 同一段变化不该在下一张图里重复出现。
     * 没开 `changeLog` 时它永远返回空数组，这里连字段都不加。
     */
    const ch = pipeline?.drainChanges?.() ?? [];
    if (ch.length) sheet.changes = ch;
    return sheet;
  }

  /**
   * 一次交 N 张（超省模式）时的台词挂载。
   *
   * **为什么不能对每张各调一次 `attachLines()`**：那个窗口两头各留了 400/800ms 的余量
   * （迟到转写不能丢），于是**跨在边界上的那句话同时落进相邻两张的窗口**。一张张交的
   * 时候看不出来（隔着两轮），一次交三张就是同一句台词在结果里出现两次，而且第二份还会
   * 被标成 `#1` —— 它其实属于上一张的最后一格。
   *
   * 所以：窗口按时间正序算（`lastSheetWallTo` 是单调推进的水位线），再把候选台词**按 `t0`
   * 归张** —— 一句话只跟它开始时刻所在的那一张走，不重不漏。
   */
  function attachSheets(list) {
    if (!list?.length) return [];
    if (list.length === 1) return [attachLines(list[0])];
    const windows = list.map((s) => {
      const to = s.wallTo ?? Date.now();
      const from = lastSheetWallTo || Math.min(s.wallFrom ?? to, to - 20_000);
      if (to > lastSheetWallTo) lastSheetWallTo = to;
      return { from, to };
    });
    const buckets = bucketLines(windows, windows.map((w) => listener.between(w.from - 400, w.to + 800)));
    buckets.forEach((lines, i) => { if (lines.length) list[i].lines = lines; });

    /**
     * 变化日志一次取空，**不能整批都挂在第一张上**：那张的时间窗只覆盖前 1/3，
     * 模型会把后面的变化读成"这张图上发生的"。按 `c.to` 分给盖住它的那张，
     * 超出最后一张的归最后一张。
     */
    const ch = pipeline?.drainChanges?.() ?? [];
    if (ch.length) {
      const bucketsOfChange = list.map(() => []);
      for (const c of ch) {
        let i = list.findIndex((s) => c.to <= s.to + 1e-6);
        if (i < 0) i = list.length - 1;
        bucketsOfChange[i].push(c);
      }
      bucketsOfChange.forEach((b, i) => { if (b.length) list[i].changes = b; });
    }
    return list;
  }

  /** 丢掉预留（换管线 / 插话截断 / 已取走）。 */
  function dropReserved() { reserved = null; }

  /**
   * **取走队列里能拿的图** —— `watch` 和 `peek` 唯一的取图口。
   *
   * 两条路径各写一句 `pipeline.take()` 的话，预留的那张永远拿不到（peek 只看队列），
   * 等于白留。所以必须收成一个函数，顺手把"谁取的、空了几次"记下来。
   *
   * **为什么返回数组**：超省模式（`wakeBatch > 1`）下，叫醒一次只交一张等于白攒 ——
   * 剩下两张模型还得再 `peek` 两次，唤醒次数一点没少，"每轮重过一遍上下文"那笔钱
   * 也就一分没省。所以这里一次把队列里攒的都取走，上限 `wakeBatch`。
   *
   * 顺序是**时间正序**：预留的那张（叫醒时占住的最老一张）在前，队列里更新的在后。
   *
   * @param {'peek'|'watch'} [by] 记账用（不传就是内部调用，不计数）
   * @returns {object[]} 空数组 = 真的一张都没有
   */
  function takeSheets(by) {
    const out = [];
    if (reserved) {
      const r = reserved;
      reserved = null;
      // 过期就**当它不存在**：模型没来取，这张已经旧了，交给队列里更新的那张
      if (Date.now() - r.at <= reserveSec * 1000) {
        out.push(r.sheet);
        takes.reserved += 1;
      }
    }
    const batch = Math.max(1, Math.trunc(wakeBatch) || 1);
    while (out.length < batch) {
      const s = pipeline?.take?.() ?? null;
      if (!s) break;
      out.push(s);
    }
    if (by) {
      takes[by] += 1;
      if (!out.length) takes[`${by}Empty`] += 1;
    }
    return out;
  }

  /**
   * **唤醒前占住这一张**（见 `reserved` 的注释）。
   *
   * @returns {{seq:number, from:number, to:number, frames:number}|null}
   *   `null` = 队列已经空了（这一张在叫醒之前就被别人取走了）——
   *   调用方**不该叫醒**：叫醒了也是空手，那正是这次要修的病。
   */
  function reserveSheet() {
    const p = pipeline;
    const sheet = p?.take() ?? null;
    if (!sheet) return null;
    // 上一次预留没被取走 = 模型压根没 peek。新的一张更新，按 queueDepth 的口径让它顶掉。
    reserved = { sheet, at: Date.now(), seq: p?.stats?.sheets ?? 0 };
    return {
      seq: reserved.seq,
      from: sheet.from,
      to: sheet.to,
      frames: sheet.frames?.length ?? 0,
    };
  }

  /**
   * 叫醒失败：把预留的这张**放回队首**。
   *
   * 不放回去就是"图出了又没了"—— 这次是我们自己弄丢的，比被别的路径抢走更难查。
   */
  function releaseSheet() {
    if (!reserved) return false;
    const sheet = reserved.sheet;
    reserved = null;
    return pipeline?.restore?.(sheet) ?? false;
  }

  /**
   * 建当前管线时用的**调用方参数**（不含 oneShot）。
   *
   * 为什么需要：分辨率换了可以看 `quality`，但"逐帧模式"换的是管线参数
   * （`maxFrames` / `strategy`）—— 那些是建管线时定死的，运行中改不了。
   * 于是 watch 每次比一下签名，变了就重开：`{}` 和 `{maxFrames:1,strategy:'single'}`
   * 是两套完全不同的出图口径，不能在同一根管线上混着跑。
   */
  let runOpts = {};
  // 共享一个 watcher：每做一个新的会重新 prime（只记位置不读旧消息），
  // 那模型思考期间用户说的话就永远看不见了。
  const chatPoll = chatWatcherShared();
  let windowState = null;
  let windowPending = null;
  /**
   * 这一次会话里**窗真的开起来过**没有。
   *
   * 循环靠它区分两件完全不同的事：
   *   - 窗开过、现在没了 → **用户关掉了**，该停下来（那是"我不看了"）
   *   - 窗从来没开起来（没有带 tkinter 的 python）→ 不该当成用户关窗，继续看
   * 没有这个标记的话，第一种情况永远检不出、第二种情况会误判成挂断。
   */
  let windowOpened = false;

  /**
   * 待领的说明（挂断那一条）。
   *
   * **为什么不写进 chat.jsonl**：窗被关掉之后，写进那条流的字没有任何人会看到；
   * 模型也拿不到，于是它继续调 `watch` —— 实测会连写两条挂断说明（相隔 96ms），
   * 模型却在说"我还在看"。
   *
   * 正确的路子和陪看一样：落在这里，下一次工具结果把它带走。
   */
  let pendingNote = null;
  /**
   * 用户"关窗挂断"过没有。
   *
   * 关窗之后再被叫醒一次，`watch` 会**重新把窗开起来**、把采集重启 ——
   * 用户看到的是"关不掉，只能卸载插件"（社区实报）。所以这里是个硬闸：
   * 挂断之后只有**显式指定来源**（用户说了要看什么）才允许重新开始。
   */
  let hungUp = false;
  /** 挂断时 pid 文件的 mtime；用来识别"用户又手动把窗开回来了" */
  let hungUpStamp = 0;
  /** 最近一次的采集源（teardown 会把 `source` 清空，但事后判断还需要它） */
  let lastSource = null;
  /**
   * 已经放完的文件源。**文件回放是一次性的**：放完就结束，不能自动重播。
   *
   * 以前 `watch` 会在 `stopped` 时用 `prevSrc` 自动重启，而文件源重启就是
   * "从头再放一遍"，于是 24 秒解 1955 帧、出一堆图、把模型反复叫醒，
   * 关窗也停不下来（社区实报的那条）。
   */
  let endedSource = null;
  /** 最近一次 portal 采集报上来的流尺寸（逻辑像素）—— region 坐标就在这个空间里。 */
  let portalStream = null;
  /** 当前该把帧推进哪根管线（热切换会换 pipeline，但 spawner 的回调是建进程时绑的） */
  let sink = null;

  /** 指示框的延迟关闭：换清晰度时 teardown→start 是连着的，立刻关会闪一下 */
  let indicatorStopTimer = null;
  function stopIndicatorSoon() {
    if (indicatorStopTimer) clearTimeout(indicatorStopTimer);
    indicatorStopTimer = setTimeout(() => {
      indicatorStopTimer = null;
      stopIndicator();
    }, 2000);
    indicatorStopTimer.unref?.();
  }

  function teardown(why) {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    // 采集停了，屏幕上的"有人在看"也该跟着灭
    stopIndicatorSoon();
    run?.stop();
    run = null;
    running = false;
    source = null;
    stoppedAt = Date.now();
    // 采集收工，声音也一起停：一个抓回环的进程常驻在后台，用户是看不见的
    listener.stop('采集收工');
    if (why) log(`收工：${why}`);
  }

  /** 停采集，但留一个宽限期 —— 这期间再来 watch 不用重新热启动 */
  function armGrace() {
    if (graceTimer) clearTimeout(graceTimer);
    if (graceSec <= 0) { teardown('grace=0'); return; }
    graceTimer = setTimeout(() => teardown(`${graceSec}s 没人来`), graceSec * 1000);
    graceTimer.unref?.();
  }

  /**
   * 续命（常驻循环每拍调一次）。
   *
   * **不加这个，循环会被宽限期饿死**：一次 `watch` 结束后留 60 秒宽限，时间一到采集收工，
   * 而静止屏幕上 60 秒内又不会出新图 —— 循环下一拍看到 `!running && !pending`，
   * 就判定"采集自己停了"并自杀。用户安安静静看文档时，这个"常驻循环"最多活 60 秒。
   *
   * 只续"还在跑"的采集：ffmpeg 真死了不能靠它诈尸。
   */
  function touch() {
    if (!running) return false;
    armGrace();
    return true;
  }

  // 播放状态：只有文件源会变。窗口通过它显示"暂停中 / 第几秒"。
  let playbackState = 'stopped';
  let playbackPosition = 0;
  /** 把播放状态推给悬浮窗；旧窗口没有这条通道，是空操作。 */
  function publishPlayback() {
    try { sendWindowState({ playback: playbackState, positionSec: playbackPosition }); } catch { /* 窗口没开 */ }
  }

  /**
   * 两个"允许在 running 时进入"的开关，语义不同，都要：
   *
   * - `restart`（PR #42）：seek / configure 用。换源或换档位必须**真的重开采集**，
   *   否则 `running` 直接短路返回 already，动作等于没做却回 ok。
   * - `reuse`（PR #38 热切换）：允许进入，但**能复用就复用** —— portal 的 worker 支持
   *   `run.update()` 时就只换 gst 管线，不重开会话（握手指令贵且脆）。
   */
  async function start({ src = { kind: 'screen' }, opts = {}, quality: q = null,
    restart = false, reuse = false } = {}) {
    if (running && !restart && !reuse) return { already: true, source };
    // 走到这里就是"明确要开始看"（watch 的自动重启已经在前面被硬闸挡住了）。
    hungUp = false;
    endedSource = null;
    /**
     * 台词水位线归零。`lastSheetWallTo` 是"上一张图取到哪儿"，跨会话留着会让
     * 新一轮第一张的时间窗从**上一轮结束**算起 —— 上一轮最後那几句（甚至更早）
     * 会被当成这一轮说的话挂上去，偏移是负的（issue #39）。
     * 归零之后走首次分支：从这张图往回看 20 秒。
     */
    lastSheetWallTo = 0;
    // **窗被用户关掉之后，这里必须复位**：`windowState` 缓存着 `{ok:true}`，
    // `windowOpened` 也还是 true —— 不复位的话下一次 watch 会（a）不再开窗，
    // （b）循环立刻又把"窗没了"判成用户关窗，落第二条挂断说明。
    if (!windowAlive()) { windowState = null; windowOpened = false; }
    let engine = src.engine ?? 'auto';
    if (src.kind === 'screen' && engine === 'auto') {
      /**
       * Linux 的屏幕源走 xdg-desktop-portal 的 ScreenCast（`engine: 'portal'`）。
       *
       * 不调 `pickScreenEngine()`：那个探测只认 Windows 的 ddagrab 和 macOS 的
       * avfoundation，Linux 上它只会抛「还没接」。Wayland 下 ffmpeg 也没有正路
       * （x11grab 抓的是 XWayland 根窗口，里面没有原生 Wayland 窗口；kmsgrab 要 root）。
       */
      engine = process.platform === 'linux' ? 'portal' : await pickScreenEngine({ ffmpegPath });
    }
    // 没传 quality = 保持当前档（以前会悄悄退回默认档，尺寸一变就重开采集）
    const wantQuality = q ?? quality;
    const size = SIZES[wantQuality] ?? SIZES[DEFAULT_QUALITY];
    /**
     * region 模式：`width/height` 是**单格**尺寸（长边 = 档位长边），不是画布。
     *
     * 采集侧按单格抓、出图时再按实际帧数拼（2 帧 2×1 / 4 帧 2×2）——
     * 这样 2 帧不会浪费半张画布；而且 ffmpeg 的 `scale=w:h` 与 region 同比例，
     * 属于等比缩放，不变形。
     */
    const longEdge = LONG_EDGE[wantQuality] ?? LONG_EDGE[DEFAULT_QUALITY];
    const [w, h] = src.region ? cellSize(longEdge, src.region) : size;
    const regionOpts = src.region ? {
      region: src.region,
      // 硬上限 4（6 帧要 3×2 或 6×1，后者长宽比 3.4 —— 今天实测糊掉的就是它）；
      // 期望 2（竖屏 2 帧并排 = 1.125，最接近 1:1）。
      // 逐帧模式（`maxFrames: 1`）下两个都收敛到 1，保持「一张图一个画面」。
      // **上限钉死 4**：0.0.8 的 action 档会往 opts 里塞 `maxFrames: 8`，region 不能
      // 继承它 —— 上限只该由 region 自己说，不能靠 preferFrames 去掩盖。
      maxFrames: Math.min(4, Math.max(1, Number(opts.maxFrames) || 4)),
      preferFrames: Math.min(Math.max(1, Number(opts.maxFrames) || 4), 2),
      /**
       * **region 不出音轨条**。那里的画布是"一小块窗口"（竖屏 9:16 时 800×450、
       * 更窄的可能只有 200 宽），按宽度比例算的条会吃掉 10% 以上的画面，
       * 而 region 的用途是"把这块看清楚"，不是看视频节奏。
       */
      audioStrip: false,
    } : {};
    // oneShot 由调用方（watch）决定：**只有换清晰度**时置 true（缓冲区刚扔，等攒满等于白等一个窗口）
    const p = createPipeline({
      ...opts, width: w, height: h, ...regionOpts,
      // 变化日志是会话级偏好（配置项），不该被单次 watch 的 opts 覆盖
      changeLog,
      /**
       * **队列能压几张 = 超省模式攒几张**。
       *
       * 默认 `queueDepth: 1` 是"出新图就挤掉旧的" —— 那是最新一张的语义，
       * 也是 `wakeBatch: 1` 时正确的东西。但超省模式要的是"攒"，压不住就等于没攒：
       * 第 3 张出来时前两张已经被挤掉了，`takeSheets()` 只能拿到一张。
       */
      queueDepth: Math.max(1, Math.trunc(wakeBatch) || 1),
      /**
       * 档位映射：调用方指定优先，否则用设置页里的全局值。
       * `opts.strategy` 单独传了（比如逐帧模式的 `'single'`）就完全不动它。
       */
      strategy: opts.strategy ?? tierStyle,
      tierMap: opts.tierMap ?? tierMap,
      // 档位判据与阈值表：调用方优先（离线标定要能单次覆盖）
      tierMode: opts.tierMode ?? tierMode,
      tierCurve: opts.tierCurve ?? tierCurve,
      tierThresholds: opts.tierThresholds ?? tierThresholds,
      // 打分口径的补偿（默认开）。和 changeLog 一样是会话级偏好，但**允许单次覆盖** ——
      // 离线标定要能一次开关，不然只能改配置文件再跑。
      scoreNormalize: opts.scoreNormalize ?? scoreNormalize,
      // 音量条：直接问听声音那条链要 —— 那边已经在算 RMS 了（断句要用），
      // 这里只是把它按时间窗取出来画成柱子，**不额外解码一次音频**。
      audio: { levels: (a, b) => listener.levelsBetween(a, b) },
    });
    // 记下"这次建管线用的调用方参数"（不含 oneShot）——watch 靠它发现"模式变了"。
    runOpts = { ...opts };
    delete runOpts.oneShot;
    const s = { ...src, engine };
    quality = wantQuality;
    frames = 0;
    lastError = null;
    // 换了一根管道：上一根预留的图跟着作废（它属于旧管线的时间窗，交出去只会更旧）
    dropReserved();
    pipeline = p;
    running = true;
    source = s;
    lastSource = s;
    startedAt = Date.now();
    // portal 和 ffmpeg 共用同一套逐帧回调：上游（判帧/拼图）根本不区分帧从哪来。
    const portal = engine === 'portal';
    if (indicatorStopTimer) { clearTimeout(indicatorStopTimer); indicatorStopTimer = null; }

    /**
     * Linux：采集前先把屏幕上的指示框拉起来（幂等，第二次 0 成本）。
     *
     * 光晕和状态条会被自己采进画面里，所以按它报回来的 `dpr` 换算成**设备像素**，
     * 交给 gst 在**原始分辨率**上 videocrop 掉 —— 用户看得见，模型看不见。
     * 起不来只是少个提示（crop 退回 0），不影响采集。
     */
    let portalCrop = null;
    portalStream = null;
    if (portal && process.env.SEE_NOW_INDICATOR !== '0') {
      // 用同一个 python 解析规则（DSH_PYTHON_PATH / DSH_SEE_PYTHON 优先）：
      // 有的发行版把 PySide6 装在 venv 里，系统 python3 是看不到的。
      const ind = await startIndicator({ log, pythonPath: resolvePython() });
      /**
       * **默认不裁。** 实测（KDE Plasma Wayland + ScreenCast）指示框根本进不了采集流：
       * 同一时刻截图（portal Screenshot）里框清清楚楚，而 ScreenCast 流里只有 App
       * 半透明的地方透出一点 —— 也就是说模型看不到它，裁掉反而是白丢画面
       * （顶部 55 逻辑像素 = 标题栏 / 标签页）。
       *
       * 但这条依赖合成器实现，所以留一个显式开关：真发现流里带框了，
       * 设 `SEE_NOW_CROP_OVERLAY=1` 就按逻辑像素裁掉四边 26px / 顶 55px。
       */
      if (ind.ok && process.env.SEE_NOW_CROP_OVERLAY === '1') {
        if (ind.logicalWidth && ind.logicalHeight) {
          portalCrop = {
            logicalWidth: ind.logicalWidth,
            logicalHeight: ind.logicalHeight,
            edge: ind.edge,
            top: ind.top,
          };
        } else {
          log('指示框起来了但没报逻辑尺寸 —— 不裁');
        }
      } else if (!ind.ok) {
        log(`指示框没起来（采集照旧，屏幕上不会有光晕）：${ind.reason}`);
      }
    }
    /**
     * 热切换：只让 worker 换 gst 管线，不重开 portal 会话。
     * 会话握手是贵且脆的部分（授权 / 节点 / fd），换 crop/scale 没必要重来。
     */
    if (reuse && typeof run?.update === 'function') {
      const ok = run.update({
        width: p.constants.width,
        height: p.constants.height,
        fps: p.constants.fps,
        region: s.region ?? null,
        crop: portalCrop,
      });
      if (ok) {
        sink = p;
        pipeline = p;
        quality = wantQuality;
        source = s;
        lastSource = s;
        runOpts = { ...opts };
        startedAt = Date.now();
        frames = 0;
        lastError = null;
        dropReserved();
        log(`热切换：${p.constants.width}×${p.constants.height}（不重开会话）`);
        return { started: true, hotSwapped: true, source: s, engine, quality, params: p.constants };
      }
      log('热切换失败（worker 不收 update），退回重开采集');
    }
    const onFrame = (f) => {
      frames += 1;
      // 一帧解码就抛 = 整条管线停摆，这里必须兜住：宁可少一帧，不能让采集线程炸掉
      try { sink?.push(f); } catch (e) { lastError = `push: ${e?.message ?? e}`; }
    };
    const onStderr = (s2) => { if (process.env.DSH_SEE_NOW_DEBUG) log(s2.trim()); };
    sink = p;
    run = portal
      ? spawnPortalFrames({
          width: p.constants.width,
          height: p.constants.height,
          fps: p.constants.fps,
          crop: portalCrop,
          // region 的坐标就是**采集流的坐标系**：worker 拿 portal 报的 size 直接 videocrop
          region: s.region ?? null,
          onReady: (info) => {
            portalStream = {
              width: info.stream_width || null,
              height: info.stream_height || null,
              region: info.region ?? null,
            };
            // 落盘给取框窗用：它要知道流坐标和 Tk 屏幕坐标的比例
            if (portalStream.width && portalStream.height) {
              saveStreamSize({ width: portalStream.width, height: portalStream.height });
            }
          },
          onFrame,
          onStderr,
        })
      : spawnFrames({
          source: s,
          width: p.constants.width,
          height: p.constants.height,
          fps: p.constants.fps,
          ffmpegPath,
          engine,
          // PR #42：seek 之后每帧时间戳从起点起算（`t = baseSec + i / fps`）。
          // 不传的话清单时间和台词的 `wallTo` 会整体差一个偏移。
          baseSec: s.seek ?? s.startSec ?? 0,
          onFrame,
          onStderr,
        });
    const thisRun = run;
    run.done.then((r) => {
      if (run === thisRun) {
        // **文件正常放完（`ended`）不是错误** —— 别写进 lastError，status 里会显示成故障
        if (!r?.ended) {
          lastError ??= `${portal ? 'portal' : 'ffmpeg'} 退出（${r.frames} 帧 / ${Math.round(r.ms / 1000)}s）`;
        }
        // 文件源放完 = 这一次看完了。记下来，别让下一条 watch 又从头放一遍。
        if (s.kind === 'file') endedSource = s;
        teardown('ffmpeg-exit');
      }
    }).catch((e) => {
      lastError = `${portal ? 'portal' : 'ffmpeg'}: ${e?.message ?? e}`;
      if (run === thisRun) teardown('ffmpeg-error');
    });
    log(`开始看 ${s.kind}${engine && engine !== 'auto' ? `/${engine}` : ''} @${w}×${h}${s.region ? ` region=${s.region.x},${s.region.y},${s.region.w},${s.region.h}` : ''}`);
    /**
     * 声音并行起，**不 await**：它要等 Python 起来 + 打开回环设备（1~4 秒），
     * 挡在前面会让"开始看"从 0.4 秒变成一个明显能感觉到的卡顿。
     * 起不来只是没字幕 —— 记一条日志，看画面照旧。
     */
    listener.start()
      .then((r) => { if (!r.ok) log(`听声音没开：${r.reason}`); })
      .catch((e) => log(`听声音没开：${e?.message ?? e}`));
    // macOS 没给屏幕录制权限时，采集本身是"成功"的，只是画面全黑 ——
    // 探针已经试出来了，这里把它带回去，让模型（和用户）知道该去系统设置，而不是以为插件坏了。
    const warning = s.kind === 'screen' ? screenEngineWarning() : null;
    if (warning) log(`⚠️ ${warning}`);
    return { started: true, source: s, engine, quality, params: p.constants, warning };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 本地视频回放控制（只对文件源有效） --------------------------------
  // 屏幕源和摄像头没有"暂停/跳转"这回事，一律明确拒绝，不假装成功。
  const PLAYBACK_REASONS = {
    'not-file': '当前不是文件源，暂停、跳转和改清晰度都不适用。',
    'invalid-position': '跳转位置必须是非负秒数。',
    'busy': '正在取图，等这一轮结束再操作。',
  };
  function playback() {
    return { state: playbackState, positionSec: playbackPosition, canSeek: source?.kind === 'file' };
  }

  async function pause() {
    if (source?.kind !== 'file') return { ok: false, reason: 'not-file', text: PLAYBACK_REASONS['not-file'], playback: playback() };
    if (!run) return { ok: false, reason: 'not-file', text: PLAYBACK_REASONS['not-file'], playback: playback() };
    run.pause();
    playbackState = 'paused';
    publishPlayback();
    return { ok: true, text: '已暂停。', playback: playback() };
  }

  async function resume() {
    if (source?.kind !== 'file') return { ok: false, reason: 'not-file', text: PLAYBACK_REASONS['not-file'], playback: playback() };
    if (!run) return { ok: false, reason: 'not-file', text: PLAYBACK_REASONS['not-file'], playback: playback() };
    run.resume();
    playbackState = 'playing';
    publishPlayback();
    return { ok: true, text: '继续播放。', playback: playback() };
  }

  async function seek(position) {
    // 位置合法性先判：不管当前是什么源，非法位置都是非法。
    if (!Number.isFinite(position) || position < 0) {
      return { ok: false, reason: 'invalid-position', text: PLAYBACK_REASONS['invalid-position'], playback: playback() };
    }
    if (source?.kind !== 'file') return { ok: false, reason: 'not-file', text: PLAYBACK_REASONS['not-file'], playback: playback() };
    // 跳转要**真的重开采集**：ffmpeg 已经按旧起点在解码，光改状态不会让画面变。
    await teardown('seek');
    playbackPosition = position;
    playbackState = 'playing';
    await start({ src: { ...source, seek: position }, quality, restart: true });
    publishPlayback();
    return { ok: true, text: `已跳转到 ${position}s。`, playback: playback() };
  }

  async function configure(options = {}) {
    if (source?.kind !== 'file') return { ok: false, reason: 'not-file', text: PLAYBACK_REASONS['not-file'], playback: playback() };
    // 「不改档位」= 保持当前档位，而不是打回默认档。
    const next = options.quality ?? quality;
    await teardown('configure');
    await start({ src: source, quality: next, restart: true });
    publishPlayback();
    return { ok: true, text: `清晰度已切到 ${next}。`, playback: playback() };
  }

  /**
   * 把悬浮窗支起来（幂等）。**只在真要阻塞的时候调** —— 没在等就没必要弹窗。
   * 开不起来不算失败：模型照样能 watch，只是用户只能等下一轮。
   *
   * 注意是 await：要真跑一次 `import tkinter` 验解释器、再等 700ms 看它有没有退出，
   * 不然会拿到一个"成功"但其实早就退了的窗（pid 指向死进程）。
   */
  async function ensureWindow() {
    if (windowState?.ok) return windowState;
    if (windowPending) return windowPending;
    windowPending = openWindow({ log }).then((st) => {
      windowState = st;
      if (st.ok) {
        windowOpened = true;
        log(st.already ? '悬浮窗已开着' : `悬浮窗已开（${st.from}）`);
        /**
         * **自己开出来的窗必须是看得见的。**
         *
         * `hidden` 是磁盘上的粘性状态：用户上一次点了「藏起来」，这个窗就会带着
         * `hidden:true` 启动 —— 进程活着、心跳在跳、画面一个字都不出（2026-11-03 实报）。
         * 只在这一刻清掉它（`already` 说明窗是原来那个，用户可能正故意藏着，不动）。
         */
        if (!st.already) setWindowHidden(false, { log });
      } else {
        log(`悬浮窗没开起来：${st.reason}`);
      }
      return st;
    }).finally(() => { windowPending = null; });
    return windowPending;
  }

  return {
    start,
    pause, resume, seek, configure,
    stop() { teardown('手动'); return { stopped: true }; },
    /**
     * 用户关掉了悬浮窗 = 明确表示"不看了"。
     *
     * 只 `stop()` 不够：下一条 `watch` 看到 `stopped` 会立刻重启采集并把窗**重新开起来**，
     * 用户体感就是"关掉又弹出来，除非卸载插件"（社区实报）。这里立一个硬闸，
     * 直到有人显式指定来源为止。
     */
    hangUp() {
      hungUp = true;
      // 记下挂断那一刻的 pid 文件时间：之后只有它变了才说明窗被**重开过**
      // （见 start() 里的解除逻辑）。
      hungUpStamp = pidStamp();
      teardown('用户关窗');
      return { hungUp: true };
    },
    /** 挂断状态（测试和状态页用） */
    isHungUp() { return hungUp; },
    /** 有没有一个"已经放完、不能自动重播"的文件源 */
    endedFile() { return endedSource ? { ...endedSource } : null; },
    /** 这一轮开过窗没有（循环判"用户关窗"用） */
    windowWasOpen() { return windowOpened; },

    /**
     * 阻塞等一张图。
     *
     * `quality` 换了就**重启采集**（分辨率是采集侧定死的，改不了）：
     * 分辨率在采集那一层就定死了，所以换清晰度 = 换一根管道。重启一次 ~400ms，
     * 但换完只发一帧就把"现在是什么"给出去，不用再等攒满一张。
     *
     * @param {{seconds?:number, minFrames?:number, src?:object, quality?:string, opts?:object,
     *          signal?:AbortSignal|null, eagerMs?:number}} o
     * @returns {Promise<{ok:boolean, reason?:string, sheet?:object, waited:number}>}
     */
    async watch({
      seconds = 300, minFrames = 1, src: reqSrc = null, quality: q = null, opts = {},
      /**
       * 只看屏幕上的某一块：`{x,y,w,h}` 用这块，`null` 显式取消，`undefined` 不干预。
       *
       * **跟 `src` 分开传**：region 不算"显式来源"。下面那道挂断硬闸是给
       * "用户关掉了窗，别再自动弹出来"用的 —— 换一块看并不等于他重新要求看，
       * 不能借这个由头把闸打开（那条路最后就是"关不掉，只能卸载"）。
       */
      region = undefined,
      // 宿主给的取消信号。**必须在这里看**：不看的话用户按了停止，这个调用还要挂到封顶
      // （陪看那边专门写过这条：`signal` 是"这一轮被取消了"的唯一通知）。
      signal = null,
      // 冷启动时"先给此刻"的宽限：等第一帧最多这么久，等到就立刻出图。
      eagerMs = 3000,
    } = {}) {
      /**
       * 三个"不许自动重开"的硬闸。都来自社区实报：
       * 「回放会解 1955 帧、攒一堆唤醒、一直弹有新画面，关窗也停不干净，得卸载才行」。
       *
       * 共同原因是 `watch` 在 `stopped` 时会**自动重启采集**，而重启对文件源意味着
       * 从头再放一遍，对关过窗的用户意味着"我刚关掉它又弹出来了"。
       * 所以：只有**显式传了来源**（用户明确说要看什么）才允许清闸重开。
       */
      const explicitSrc = Boolean(reqSrc && reqSrc.kind);

      /**
       * region 落到"这次要抓的那个源"上。
       *
       * 不传 `src` 时按上一次的源走；上一次是**文件回放**就不套屏幕区域
       * （region 是 gdigrab 的输入侧参数，对文件没有意义）。
       */
      let src = reqSrc;
      if (region !== undefined) {
        const prevKind = (source ?? lastSource)?.kind ?? 'screen';
        if (src === null && prevKind === 'file') {
          // 放着，让下面按文件继续；region 被忽略，调用方（index.js）会说明
        } else if (src === null || src.kind === 'screen') {
          src = { ...(src ?? { kind: 'screen' }) };
          if (region) {
            src.region = region;
            // ddagrab 没有 -offset_x：带 region 必须走 gdigrab（见 capture.js）。
            // **Linux 例外**：那边走 portal，region 由 worker 在流上 videocrop，
            // 钉成 gdigrab 会让 ffmpeg 去开一个不存在的输入格式（0 帧、没报错）。
            if (process.platform !== 'linux') src.engine = 'gdigrab';
          } else {
            delete src.region;
            if (!reqSrc) delete src.engine;
          }
        }
      }

      // **手动重开窗 = 用户又想看了**，挂断的前提（"窗没了"）已经不成立。
      // 社区实报：关窗后跑 `bin/see-window.mjs --force` 把窗拉回来，再看就永远被拒 ——
      // 因为 `hungUp` 是**本进程内存里的一个变量**，而那个脚本是另一个 node 进程，
      // 它只杀/重开 python 窗口，碰不到这里。重启 DSH 能恢复也正是因为它重置了这个值。
      // 所以判据改成看事实：窗活着就不是"用户关掉了"。
      if (resumeFromReopen({
        hungUp, winAlive: windowAlive(), pidNow: pidStamp(), pidAtHangUp: hungUpStamp,
      })) {
        hungUp = false;
        log('悬浮窗被重新打开过 —— 解除挂断，继续看。');
      }

      /**
       * `fileEnded` 只在**采集已经停了**的时候才算数。
       *
       * 为什么：文件还在播（`running` 为真）时，`watch` 走的是"接着等下一张"，
       * 根本不是重播；这时候拦下来就是"看个视频，第二次 `watch` 就说文件放完了"。
       * 真正的重播是"采集停了 + 不带 path 再 watch"—— 那一下才会 spawn 一根新管道、
       * 从第 0 秒重来（社区实报的 24 秒解 1955 帧）。
       */
      const blocked = guardReason({
        hungUp, fileEnded: Boolean(endedSource) && !running, explicitSrc,
      });
      if (blocked === 'hung-up') return { ok: false, reason: 'hung-up', waited: 0 };
      if (blocked === 'file-ended') {
        return { ok: false, reason: 'file-ended', waited: 0, path: endedSource?.path };
      }
      if (explicitSrc) { hungUp = false; endedSource = null; }

      if (busy) return { ok: false, reason: 'busy', waited: 0 };
      busy = true;
      const t0 = Date.now();
      try {
        const prevSrc = source ?? lastSource;
        const switching = Boolean(pipeline) && q && SIZES[q] && q !== quality;
        /**
         * region 变了（窗口挪了 / 换了窗口 / **取消掉**）也必须重开：`-offset_x` 是建管道时
         * 定死的，不重开的话新 region 会被**静默忽略** —— 用户以为框住了，其实还在抓老地方。
         *
         * "一边有一边没有"也算变了：以前只比四个数字，于是 `region:"off"` 这种
         * **撤回**永远不触发重开 —— 用户点了取消，画面还在抓那一小块。
         */
        const a = prevSrc?.region ?? null;
        const b = src?.region ?? null;
        const regionChanged = Boolean(pipeline)
          && Boolean(a || b)
          && (a?.x !== b?.x || a?.y !== b?.y || a?.w !== b?.w || a?.h !== b?.h);
        // 管线参数变了（常规 ↔ 逐帧）：这两套口径建管线时就定死了，只能重开。
        const modeChanged = Boolean(pipeline) && optsSig(runOpts) !== optsSig(opts);
        /**
         * **要不要重开采集**：`pipeline` 不为空**不等于**采集还在跑。
         *
         * `teardown()` 故意留着 `pipeline`（好把队列里剩下的图发完），于是宽限期到点、
         * 或者模型 `stop` 之后，`pipeline` 还在但 `running` 已经是 false ——
         * 只看 `!pipeline` 就会"跳过启动、直接等一张永远不会来的图"，等到封顶才回一句
         * "没看成"。用户看到的是"第一次能看，第二次就不行了"。
         */
        const stopped = Boolean(pipeline) && !running;
        // **冷启动**（手上没有管线，或采集已经停了）才 eager。换清晰度不算 —— 那条路已经用 oneShot 了。
        const cold = !pipeline || stopped;
        const hotSwap = Boolean(pipeline && !stopped && !modeChanged
          && (switching || regionChanged) && run && typeof run.update === 'function');
        if (hotSwap) {
          await start({
            src: src ?? prevSrc ?? { kind: 'screen' },
            opts: { ...opts, oneShot: true },
            quality: q,
            reuse: true,
          });
        } else if (!pipeline || stopped || switching || modeChanged || regionChanged) {
          if (pipeline) {
            teardown(stopped ? '采集已停，重开'
              : switching ? `换清晰度 ${quality} → ${q}`
                : regionChanged ? 'region 变了，重开' : '换模式（逐帧 / 常规）');
          }
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
          await start({
            src: src ?? prevSrc ?? { kind: 'screen' },
            // 只有**换清晰度**才 oneShot：那一下缓冲区刚被扔掉，等攒满一张就等于白等一整个窗口。
            // 普通的第一次 watch 不 oneShot —— 模型要的是"这 20 秒"，不是"此刻"。
            opts: { ...opts, oneShot: switching },
            quality: q,
          });
        } else if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

        // 真要阻塞了才支窗（第一次起进程 ~1.5s，之后是空操作）
        const win = await ensureWindow();

        /**
         * 取一条用户插话（没有就 null）。
         *
         * 只写一份：冷启动的 eager 和正常等待**都要先看插话**，各写一套就会出现
         * "eager 那段把话吃了但没带上"这种只在首帧复现的丢话。
         */
        const pollUser = () => {
          const said = chatPoll().filter((e) => e.role === 'user');
          if (!said.length) return null;
          return said.map((e) => e.text).join(' / ').slice(0, 800);
        };

        /**
         * 截断出图（插话 / 冷启动首帧 / 超时兜底）。
         *
         * **预留的那张同时作废**：这三条路交出去的都是"此刻"，而预留的是叫醒时的那一刻 ——
         * 留着它只会让下一次 `peek` 拿到一张比手上更旧的图。
         */
        const flushNow = (t = null, why = 'user') => {
          dropReserved();
          return pipeline?.flushNow(t, why) ?? null;
        };

        /** 用这句话截断出图（插话优先于一切：不等判据、不排队） */
        const interjectNow = async (text) => {
          // 记一条待回执：下一轮工具结果里如果还没带 `say`，就把「你还没回她」顶出来。
          // 模型很可能先去取图了，回来时那段话已经不在上下文最前面（陪看那边实报过）。
          noteInterjected(text);
          // 刚开采集时可能一帧都还没到（-probe 那几百毫秒）—— 用户问"这是什么"，
          // 空着手回去等于没看。最多等 0.8s 让第一帧到，再截断。
          for (let i = 0; i < 8 && pipeline && !pipeline.hasFrame; i += 1) await sleep(100);
          const now = flushNow(null, 'user');
          const waited = (Date.now() - t0) / 1000;
          return now
            ? { ok: true, sheets: [attachLines(now)], waited, quality, userText: text }
            : { ok: false, reason: 'user-no-frame', waited, userText: text };
        };

        const deadline = t0 + Math.max(2, seconds) * 1000;
        // **登记成"我在等用户说话"**：常驻循环也盯这条通道，它一旦先把话吃掉，
        // 就会走 `followup` 投进会话 —— 而会话正卡在这个工具调用里等结果，
        // 那条消息要等这一轮结束才处理，**接不住"从等待里出来"**。
        // 用户看到的就是"我在窗口里说话，它一动不动"（陪看那边实报过）。
        //
        // 冷启动的 eager 也算"在等"：那 3 秒里用户说的话同样不能被循环吃掉。
        const leaveChan = enterChatWait();
        try {
          /**
           * **冷启动先给此刻**。
           *
           * 静止屏幕上第一条要等 30~60 秒（兜底帧 20 秒一个，攒 3 帧才封箱）——
           * 用户说"看看我屏幕"，等一分钟才回话，体感就是"它没反应"。
           * 所以冷启动时第一帧到手就发，多花一张图（216 token），换"1 秒内给反应"。
           *
           * 只在冷启动生效：管温着的时候再 eager，就退化成"每帧一张图"了。
           * **插话优先**：这 3 秒里用户说话了，就按插话走（体感上他是在追问）。
           */
          if (cold && minFrames <= 1 && eagerMs > 0) {
            const eagerUntil = Date.now() + eagerMs;
            while (Date.now() < eagerUntil && !signal?.aborted) {
              const said = pollUser();
              if (said) return await interjectNow(said);
              if (pipeline?.hasFrame) {
                const first = flushNow(null, 'first');
                if (first) {
                  return {
                    ok: true, sheets: [attachLines(first)], waited: (Date.now() - t0) / 1000,
                    quality, windowOpen: win.ok, first: true,
                  };
                }
              }
              await sleep(60);
            }
          }

          while (Date.now() < deadline) {
            // 宿主取消了这一轮（用户按停止 / 超时策略）就立刻收工，别继续挂着
            if (signal?.aborted) {
              return { ok: false, reason: 'cancelled', waited: (Date.now() - t0) / 1000 };
            }
            // **插话优先于一切**：用户说话了就立刻截断，不等判据、不排队
            const said = pollUser();
            if (said) return await interjectNow(said);
            // **走 `takeSheets` 而不是 `pipeline.take()`**：叫醒时预留的那张也在这里交付
            // （它是队列里最早的一张，本来就该先给 `watch`）。两条路径各取各的话，
            // 预留的那张只能在 peek 里取到，`watch` 会以为队列是空的。
            //
            // 超省模式下这里会一次拿到多张（`wakeBatch`）。**这是省钱的唯一入口** ——
            // 一次交 N 张 = 模型一轮看完；一张张交 = N 轮，每轮都要重过一遍上下文。
            const got = takeSheets('watch').filter((x) => x.frames.length >= minFrames);
            if (got.length) {
              /**
               * **出图前等最多 300ms，让"最后一句话"赶上这张图。**
               *
               * 台词的取数窗口是「上一张的 wallTo → 这一张的 wallTo」。差几百毫秒
               * 没转完的那句会被推到下一张 —— 那就是十几秒，而 ASR 本身只有 0.7 秒。
               * 只有这条正常返回路径等；`peek`（后台唤醒）和插话要快，不等。
               */
              await listener.settle(300);
              return {
                ok: true,
                sheets: attachSheets(got),
                waited: (Date.now() - t0) / 1000,
                quality,
                windowOpen: win.ok,
              };
            }
            // 采集停了、队列和预留都空了 = 再等也不会有了
            if (!running && !pipeline?.pending && !reserved) break;
            await sleep(120);
          }
        } finally {
          leaveChan();
        }
        // 到点了：手上攒的半张也算数（用户已经在等），但不够 minFrames 就不给
        const last = flushNow(null, 'timeout');
        if (last && last.frames.length >= minFrames) {
          return { ok: true, sheets: [attachLines(last)], waited: (Date.now() - t0) / 1000, partial: true, quality };
        }
        return {
          ok: false,
          reason: signal?.aborted ? 'cancelled' : (frames ? 'no-change' : 'capture-stopped'),
          waited: (Date.now() - t0) / 1000,
          error: lastError,
        };
      } finally {
        busy = false;
        if (pipeline) armGrace();
      }
    },

    /**
     * 取走**已经拼好的那一张**（后台唤醒走这条）。
     *
     * 语义是 "grab the sheet that already piled up" —— 模型被"有新画面了"叫醒时，
     * 要的就是那张攒好的图，不该再等、也不该换一张。
     *
     * **不能走 `flushNow()`**：那是插话用的，会把 `sheets` 整个清空、再把"此刻那一帧"
     * 塞成一张新图。结果是队列里攒好的多帧摘要被一张单帧替换掉 —— 复现见 issue #1：
     * `queued [0,2,4]` → 调完 peek 变成 `[5.92]`、`pending 0`。
     * 队列空就老实返回 null（调用方会提示"下一张还在攒"），
     * 想看"此刻"请走 `watch`。
     *
     * 顺便支窗（**不等它**）：走 peek 路线的会话没有 watch 的阻塞点，
     * 不在这里开窗的话，用户永远没有可以打字的入口，也就没有"关窗 = 不看了"。
     *
     * **先给"叫醒时预留的那张"**（`takeSheet`）：从叫醒到这一声 `peek` 隔着 1~3 秒，
     * 这期间队列可能已经被别的路径取空了 —— 那正是"叫了 6 次、多数 peek 是空"的原因。
     */
    peek() {
      // 超省模式下这里可能一次拿到多张 —— 和 `watch` 同一个口径，
      // 否则"攒了 3 张但 peek 只给 1 张"等于白攒。
      const queued = attachSheets(takeSheets('peek'));
      if (running) armGrace();
      if (!windowState?.ok && !windowPending) void ensureWindow();
      return queued;
    },

    /**
     * **唤醒前占住这一张**（常驻循环专用，见 `reserved` 的注释）。
     *
     * `null` = 队列已经空了：这一张在叫醒之前就被取走了，**不该叫醒** ——
     * 叫醒了也是空手，只会让模型白跑一轮还看不见东西。
     */
    reserveSheet,

    /** 叫醒失败：把预留的那张放回队首（不然图就被我们自己弄丢了） */
    releaseSheet,

    /** 常驻循环每拍续命（见 touch 的注释） */
    touch,

    /** 落一条说明，等下一次工具结果带走（挂断那一条走这里） */
    note(text) {
      const t = String(text ?? '').trim();
      if (t) pendingNote = t;
      return pendingNote;
    },

    /** 取走说明（取完就没了：同一句话不该每一轮都念一遍） */
    takeNote() {
      const n = pendingNote;
      pendingNote = null;
      return n;
    },

    status() {
      return {
        running,
        source,
        lastSource,
        hungUp,
        endedFile: endedSource?.path ?? null,
        quality,
        size: SIZES[quality],
        frames,
        since: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
        lastError,
        idleSec: stoppedAt ? Math.round((Date.now() - stoppedAt) / 1000) : 0,
        stats: pipeline?.stats ?? null,
        pending: pipeline?.pending ?? 0,
        // 叫醒时预留的那张还在手上没有（`peek` 会先给这张）。
        // `pending: 0` 但这里不为空 **不是**异常：说明叫醒已经发生、图在等人来取。
        reserved: reserved ? {
          seq: reserved.seq,
          ageSec: Math.round((Date.now() - reserved.at) / 1000),
          to: reserved.sheet.to,
        } : null,
        // 取图记账。「叫醒了却没图」时看这三个数：`peekEmpty` 涨 = 真的是空手，
        // 不涨而模型说没图 = 它根本没 peek（或者 peek 的不是这个会话）。
        takes: { ...takes },
        // 出图序号（单调递增）：常驻循环靠它保证"同一张图只叫醒一次"。
        // `pending` 只说明"队列里有"，不说明"是不是新的一张"—— 模型不取的话它一直是 1。
        sheets: pipeline?.stats?.sheets ?? 0,
        // 本批第一帧到现在多久：唤醒文案里要说"攒了多久"，不然模型不知道这段时间有多长
        secondsSinceWake: pipeline?.secondsSinceWake ?? null,
        // 这一轮开过窗没有（循环靠它区分"用户关了窗" 和 "窗压根没开起来"）
        windowOpened,
        // 开窗结果与失败原因：**"它在看但我什么都看不到"时第一个要看的就是 reason**
        // （没有带 tkinter 的 python 是最常见的一种，那时窗根本不会出现）
        window: { ok: windowState?.ok ?? null, reason: windowState?.reason ?? null, script: windowState?.from ?? null },
        // 屏幕上的指示框（贴边光晕 + 状态条）：在跑就报逻辑尺寸和边宽
        indicator: indicatorState(),
        // 采集流的真实尺寸（region 的坐标系）——模型量坐标时要看这个数
        stream: portalStream,
        // 有没有待领的说明（挂断那条）—— status 里看得见，才不会"明明写了没人读"
        notePending: Boolean(pendingNote),
        // 听声音的状态。"它好像没听见台词"时第一个要看的就是它：
        // enabled=false 的 reason 会直接说是缺服务、缺 Python、还是抓不到回环设备
        listen: listener.state(),
      };
    },
  };
}
