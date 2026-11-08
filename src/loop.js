/**
 * loop.js — 常驻看屏幕：起钟、看有没有新图、到点叫醒模型。照搬 `watch-together/watch-loop.js` 的骨架。
 *
 * ## 为什么必须有这一层
 *
 * 最早这里是"模型调 `watch(20s)` → 拿一张图 → 回话 → 再调一次"。实测跑不住：
 * **模型拿到图、回完话就结束了**，用户看到"它答一句就没下文了"。
 * 模型没有理由主动再调一次 —— 它不知道下一次该什么时候调，也没人提醒它。
 *
 * 钟必须在插件里：
 *
 *   每 2 秒   本地判定（读一眼队列深度、窗还在不在），纯算术，几乎不花钱
 *   真该看时  叫醒模型（往会话投一条消息 = 模型跑一轮，这才贵）
 *
 * 用户看两小时 ≈ 几十次唤醒，不是几千次。
 *
 * ## 三个停下来的条件
 *
 * 1. **用户关掉悬浮窗** —— 那是"我不看了"最直接的意思。落一条 hangup，之后不再唤醒。
 * 2. **模型调 `stop`** —— 明确说不看了。
 * 3. **采集真的死了**（ffmpeg 退出、源断了）或**连续叫不醒**。
 *
 * ## 刻意不接 `exec.signal`
 *
 * 以前这里接的是工具调用的 signal，`aborted` 就停。那是**单次调用**的通知
 * （宿主类型注释：`abort signal shared by the step`），不是"一直看下去"这件事的状态。
 * 接上去的结果是：这一轮以任何方式结束，常驻循环就跟着死 —— 用户看到的就是
 * "它答一句就完了"。取消/超时的处理放在 `runner.watch()` 自己的等待循环里。
 */

import { startTicker, wakeWithRetry } from './timer.js';
import { windowAlive, windowPidAlive } from './window.js';
import { appendSpoken, chatWatcherShared, chatWaiterCount, lastSaidNote, muteNote } from './chat.js';
import { noteInterjected } from './interject.js';
import { onSpeech, speechSubscribers } from './speech.js';
import { estimateSpeechMs, nextProactiveAt } from './pacing.js';

/**
 * 用户插话的"同一拍"判定（毫秒）。
 *
 * **不是冷却**：插话本身不做节流（人不会一秒钟发十条）。这 500ms 只用来挡住
 * "同一拍里连着来两条"——那种情况下面模型这一轮刚开头，`followup` 投进去
 * 必定变成排队消息。放回队里等下一拍再投，话不丢。
 */
const INTERJECT_GAP_MS = 500;

/**
 * 两张图之间至少隔这么久才叫醒模型。
 *
 * 动态画面 2~3 秒就出一张，按出图节奏叫，模型会每 3 秒说一句 —— 那是刷屏，不是陪看。
 * 8 秒是"不快于一口气说完两句话"的下限；真该说的时候（用户插话）不受这个限制。
 */
const WAKE_MIN_GAP_MS = 8000;
const TICK_MS = 2000;
/** 连续这么多次叫不醒就停：会话没了还每 8 秒烧一次模型，是最贵的失败模式 */
const WAKE_FAILS_MAX = 2;

/** 没开悬浮窗、用户又这么久没说话 → 认为没人看，收工 */
export const IDLE_STOP_MS = 3 * 60 * 1000;
/** 连续这么多次自动唤醒都没有用户搭理 → 收工（防"窗开着但人走了"/模型自己读图循环） */
export const MAX_AUTONOMOUS_WAKES = 8;

/**
 * 该不该因为「没人在看」收工 —— 抽成纯函数，好测也好读。
 *
 * 社区实报「装上后卡读图循环」：常驻循环原来**只有"采集停了"一个退出条件**，
 * 屏幕一直动（放视频、刷网页）就会每 15 秒叫醒模型一次，永远不停。
 */
/**
 * 判到 idle 之后该干什么。
 *
 * `stop` = 彻底收工（窗都没了，留着循环只是白烧）；`listen` = 只停采集、**留着耳朵**。
 *
 * 社区实报 2026-11-03：窗开着、循环因为连续叫不醒收工，用户之后在窗里打的字
 * 没有任何人读 —— 可那扇窗还摆在屏幕上，他当然以为自己在跟它说话。
 */
export function idleAction({ idle = false, windowOpen = false } = {}) {
  if (!idle) return 'continue';
  return windowOpen ? 'listen' : 'stop';
}

export function shouldGoIdle({
  wakesSinceUser = 0, now = Date.now(), lastUserAt = now, windowOpen = false,
  maxWakes = MAX_AUTONOMOUS_WAKES, idleStopMs = IDLE_STOP_MS,
} = {}) {
  // 两条线都能由 ~/.dsh/see-now.json 覆盖（#8）：写死的 8 次在悬浮窗开着时
  // 就是实际的最长陪看时长，想陪久一点的人只能改源码。
  if (maxWakes > 0 && wakesSinceUser >= maxWakes) return true;
  // 悬浮窗开着 = 有人在陪看，中途不说话是正常的，只靠"叫太多次"兜底
  // idleStopMs <= 0 = 用户主动关掉这条（愿意一直陪着）
  if (!windowOpen && idleStopMs > 0 && now - lastUserAt > idleStopMs) return true;
  return false;
}

/**
 * 窗"看起来没了"要连续这么多拍才认（一拍 2 秒）。
 *
 * 心跳本来是 6 秒算过期，用来决定"要不要重开窗"是合适的；但机器睡一觉醒来、
 * 或者窗口主线程被 DWM/抓屏拖住几秒，心跳一样会过期，而用户什么都没做。
 */
export const WINDOW_GONE_TICKS = 3;

/**
 * 窗"没了"该怎么判 —— 抽成纯函数，好测也好读。
 *
 * **为什么不能直接 `!windowAlive()` 就挂断**：`windowAlive()` 回答的是
 * "这窗还能用吗"（心跳 6 秒过期就算不能用，宁可重开一个），而这里要回答的是
 * **"用户是不是不看了"**。两个问题共用一个判据的后果是单向的：
 *   - `index.js` 的 `onStop` 看到 `window-closed` 会落一条挂断说明，内容是
 *     "用户关掉了悬浮窗 —— 用户关它就是在说「不看了」……不要再调 see_now"；
 *   - 还会 `runner.hangUp()`，之后 `watch` 一律被硬闸拦（`guardReason`）。
 * 也就是说：**一次心跳抖动 = 这个会话再也回不来**，用户看到的就是"它自己结束了"。
 * 实测复现：pid 指向活着的进程、只把心跳文件的 mtime 往前拨 8 秒，
 * 循环第一拍就 `window-closed`。
 *
 * @returns {'closed'|'stalled'|null}
 *   - `closed`：进程真没了（用户关的，或它崩了）→ 照旧停 + 挂断
 *   - `stalled`：进程还在、只是心跳断了 → 连续够多拍才停，**且不挂断**，
 *     下一条 `watch` 能自己把窗重开起来
 */
export function windowVerdict({ wasOpen = false, alive = false, pidAlive = false, goneTicks = 0 } = {}) {
  if (!wasOpen || alive) return null;
  if (!pidAlive) return 'closed';
  return goneTicks >= WINDOW_GONE_TICKS ? 'stalled' : null;
}

/**
 * 关窗说明。**不投 followup**（那会进排队消息区），由 `runner.note()` 挂着，
 * 下一次工具结果带走 —— 和陪看的 `markHungUp` 同一个路子。
 */
export const HANGUP_NOTE = '[看屏幕·挂断] 悬浮窗被关掉了 —— 用户关它就是在说「不看了」。\n'
  + '采集已经停，不会再出图。**不要再调 see_now**，也不要再说话。\n'
  + '只回一句短的（用 `say`，否则他看不到），比如"好，先停在这儿"。\n'
  + '他要接着看时会自己说一声，那时候再重新调 `see_now({action:"watch"})`。';

/**
 * 起一个常驻循环。
 *
 * @param {object} o
 * @param {object} o.ctx 宿主上下文（叫醒要用）
 * @param {string} o.sessionId **起循环时的那个会话**。不能每次现取：多开会话时
 *   `session/event` 会被任何一个会话更新，现取会把话投给别人。
 * @param {() => string|null} [o.getSessionId] 兜底（起循环时还没拿到 id 的情况）
 * @param {object} o.runner createRunner() 的返回值
 * @param {(m:string)=>void} [o.log]
 * @param {(reason:string)=>void} [o.onStop] 停下来时回调（落挂断说明之类）
 * @param {number} [o.wakeMinGapSec] 两张图之间的最小叫醒间隔
 * @returns {{dispose:()=>void, state:()=>object, stopped:()=>boolean}}
 */
export function startLoop({
  ctx, sessionId = null, getSessionId = () => null, runner,
  log = () => {}, onStop = () => {}, wakeMinGapSec = WAKE_MIN_GAP_MS / 1000,
  /** 一条叫醒多久没人接（没有任何工具调用）就收工；测试里可以调小 */
  unackedStopMs = 45_000,
  // 逐帧模式：唤醒文案要说"换画面了，说一句这是什么"，而不是"有新画面了"。
  scene = false,
  // `~/.dsh/see-now.json` 的节奏参数（readTuning()）；不传就用写死的默认值。
  tuning = null,
} = {}) {
  let disposed = false;
  let lastWakeAt = 0;
  /**
   * 最近一次「模型真的碰了这个工具」的时刻。
   *
   * 为什么需要它：叫醒是往会话里**投递一条消息**，宿主会把它排进队列等模型回应。
   * 模型正忙着（一轮跑几十秒）时不回应，循环却按 `wakeMinGapSec` 继续投递 ——
   * 实测积出过十几条「有新画面了」，用户一条条点掉。
   *
   * 所以规则很简单：**上一条叫醒还没被接住（没有新的工具调用），就不叫下一条。**
   * 一次只允许一条在飞。
   */
  let lastAckAt = Date.now();
  let wakeFailures = 0;
  let consecutiveFails = 0;
  let wakeCount = 0;
  let stopReason = null;
  /**
   * 上一句真正出声的时刻与估计时长（见 pacing.js）。
   *
   * 只认 `spoken`（适配器开始播放的那一瞬）：`due` 是"打算念"，离真出声还隔着合成，
   * 拿它当起点会把等待算短。没有声音适配器时永远收不到 `spoken`，节奏就退回旧的 8 秒。
   */
  let lastSpeechAt = 0;
  let lastSpeechMs = 0;
  /**
   * 节奏口径（`~/.dsh/see-now.json` 的 speechPacing）：
   *   true / 'follow'（默认）= 上一句说多久，下一句就隔多久；
   *   'guard' = 旧间隔与"说完+气口"取更晚，只在长句时推迟；
   *   false = 关掉，纯固定间隔。
   */
  const pacingMode = (() => {
    const v = tuning?.speechPacing;
    if (v === false) return 'off';
    return v === 'guard' ? 'guard' : 'follow';
  })();
  const followSpeech = pacingMode !== 'off';
  const offSpeech = onSpeech((e) => {
    if (!followSpeech) return;
    const state = e?.state;
    // 有声音适配器：等 `spoken`（真正开始播放）。没有声音：`due` 就是"这话已经给用户看了"，
    // 按它算，免得没装语音的用户被同一句文字刷屏。
    if (state !== 'spoken' && !(state === 'due' && speechSubscribers() === 0)) return;
    const ms = estimateSpeechMs(e.text);
    if (!ms) return;
    lastSpeechAt = Date.now();
    lastSpeechMs = ms;
  }, { voice: false });
  /** 起循环时的会话（一旦定下就不再变，见参数注释） */
  const owner = sessionId ?? getSessionId() ?? null;
  /** 上一张已经叫过的图（`#序号` 或 `p脉冲`），同一张永不重复叫 */
  let lastKey = null;
  /** pending 0→1 的脉冲计数：拿不到出图序号时靠它认"新的一张" */
  let pendingPulse = 0;
  let lastPending = 0;
  /** 采集停掉之后已经过了几拍 —— 用来给"队列里剩下的图"一个播报窗口，然后收工 */
  let deadTicks = 0;
  let lastWakeOk = null;
  /**
   * 「没人在看」的收工线（判据见 `shouldGoIdle`）。
   *
   * 社区实报「装上后会卡读图循环」—— 因为常驻循环**只有"采集停了"一个退出条件**。
   * 只要屏幕一直在动（放视频、刷网页），它就会每 `wakeMinGapSec` 叫一次模型、
   * 模型看一眼图回一句、下一张再叫一次，**永远不停**。用户什么都没问，会话却在
   * 一轮一轮读图。
   *
   * 两条收工线，互为兜底：
   *   - `IDLE_STOP_MS`：**没开悬浮窗**（没人看那个小窗）且用户超过 3 分钟没说话 → 停。
   *     悬浮窗开着就不判 —— 那是陪看场景，2 小时的电影中途不说话是正常的。
   *   - `MAX_AUTONOMOUS_WAKES`：连续叫了这么多次都没人搭理 → 停。
   */
  let lastUserAt = Date.now();
  let wakesSinceUser = 0;
  /** 窗"看起来没了"连续几拍（判据见 `windowVerdict`） */
  let windowGoneTicks = 0;

  /**
   * 自己盯 chat.jsonl 里的新用户消息。
   *
   * **不能靠 `pendingInterjected()`**：那个东西在提醒过一次之后就被标记成"念过了"，
   * 于是用户再说一句它也看不见。而且常驻模式下 `runner.watch()` 早就返回了 ——
   * 那里面的插话检测根本没机会跑。所以循环必须自己有一双眼睛。
   */
  const pollChat = chatWatcherShared();
  /** 还没被处理掉的插话（一次只处理一条，剩下的留着下一拍） */
  const queue = [];

  /**
   * `active` = 正常干活；`listen` = **只听不说话**。
   *
   * 为什么需要这个状态（社区实报 2026-11-03）：悬浮窗开着、但循环因为"连续叫不醒"
   * 已经收工，于是用户之后在窗里打的字**没有任何人读**。可那扇窗还明晃晃摆在屏幕上，
   * 用户当然以为自己在跟它说话。
   *
   * 收工 ≠ 拆掉耳朵。这里让循环停掉采集（省资源），但**留着 ticker 继续盯 chat.jsonl**：
   * 一旦有人开口，立刻回到 active 去唤醒模型。采集不自动重启 —— 模型要看图会调 `peek`，
   * 那时才启动，用户的 region / 清晰度设置才不会被冲掉。
   */
  let mode = 'active';
  /**
   * 采集是**我们自己为了进只听模式停掉的**。
   *
   * 没有这个标志的话，退出只听后的第一拍就会看到 `!alive` —— 那本来是我们主动停的，
   * 却会被下面 ② 判成 `capture-stopped`，于是用户刚说一句话，循环整个收工。
   */
  let pausedByListen = false;

  const enterListen = () => {
    if (mode === 'listen' || disposed) return;
    mode = 'listen';
    pausedByListen = true;
    log('进入只听模式：停止采集，但继续盯着窗口里的输入');
    try { runner.stop(); } catch { /* 已经停了 */ }
    try {
      appendSpoken('meta', '（有一阵没人说话了，我先停一停 —— 你在这儿打字我还能看见，说一声就继续看。）', { speak: false });
    } catch { /* 写不进不影响听 */ }
  };

  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    log(`循环停了：${reason}`);
    // 自动收工要在窗口里留一行灰字，不然用户只会觉得"它突然哑了"
    if (reason === 'idle') {
      try { appendSpoken('meta', '（有一阵没人说话了，我先停一停；要看再说一声。）', { speak: false }); } catch { /* 写不进不影响停 */ }
    } else if (reason === 'wake-unacked') {
      // 叫醒了但模型没调工具（只回了文本）→ 停。**也得留一行灰字**：
      // 不然用户看到的是"它突然哑了"，而这恰恰是最难自己想到原因的一种停法。
      try { appendSpoken('meta', '（叫了几声没人接，我先停一停；要看再说一声。）', { speak: false }); } catch { /* 写不进不影响停 */ }
    }
    try { onStop(reason); } catch { /* 停不下来也要停 */ }
    dispose();
  };

  /** 上一句说过什么（给唤醒文案用）：别让它在同一个屏幕上把同一句感慨说两遍 */
  function lastSaidHint() {
    return lastSaidNote({ maxAgeSec: 300, clipLen: 70 });
  }

  async function wake(text, { cooldownMs = WAKE_MIN_GAP_MS } = {}) {
    lastWakeAt = Date.now();
    const r = await wakeWithRetry({
      ctx, sessionId: owner, text, log,
      appendMeta: (m) => appendSpoken('meta', m, { speak: false }),
    });
    lastWakeOk = Boolean(r?.ok);
    if (r?.ok) {
      wakeCount += 1;
      consecutiveFails = 0;
      return true;
    }
    wakeFailures += 1;
    consecutiveFails += 1;
    if (consecutiveFails >= WAKE_FAILS_MAX) {
      // 会话可能已经关了：再叫下去只是每 8 秒白烧一次模型
      stop('wake-failed');
    }
    return false;
  }

  const ticker = startTicker({
    everyMs: TICK_MS,
    tick: async () => {
      if (disposed) return;

      // ⓪ 有阻塞等待者时**不许碰这条通道**。
      //    工具调用正卡在 `watch()` 里等用户说话，poll 是消费型的 —— 我们一吃，
      //    那边的等待就永远看不见这句话，用户侧表现是"我在窗口里说话，它一动不动"。
      //    等待者拿到话会直接返回工具结果，那才是唯一能把人从阻塞里叫出来的路。
      const waiting = chatWaiterCount() > 0;
      const fresh = waiting ? [] : pollChat();
      for (const e of fresh) {
        if (e?.role === 'user' && String(e.text ?? '').trim()) {
          queue.push(String(e.text).trim());
          lastUserAt = Date.now();
          wakesSinceUser = 0;
        }
      }

      // ① 窗被关掉 = 用户不想看了。**先判这个**：窗都没了，出图也没人在看。
      //    只在"窗确实开过"之后才判 —— 窗开不起来（没有 python）时不该被当成用户关窗。
      //    **进程没了才算关**；只是心跳过期（睡醒、主线程卡住）只累加拍数，
      //    够数才当成没了，而且不挂断（理由见 `windowVerdict`）。
      const wasOpen = runner.windowWasOpen();
      const winAlive = wasOpen ? windowAlive() : false;
      if (!wasOpen || winAlive) {
        windowGoneTicks = 0;
      } else {
        windowGoneTicks += 1;
        const verdict = windowVerdict({
          wasOpen, alive: winAlive, pidAlive: windowPidAlive(), goneTicks: windowGoneTicks,
        });
        if (verdict === 'closed') { stop('window-closed'); return; }
        if (verdict === 'stalled') { stop('window-stalled'); return; }
      }

      // ①.5 只听模式：**必须排在窗口判断之后**（否则窗关了也发现不了），
      //      也必须排在采集判断之前（我们已经主动停了采集，那里会误判成 capture-stopped）。
      //      这一拍除了"听"什么都不做。
      if (mode === 'listen') {
        if (!queue.length) return;
        mode = 'active';
        wakesSinceUser = 0;
        consecutiveFails = 0;
        lastUserAt = Date.now();
        deadTicks = 0;
        log('窗口里有人说话 —— 退出只听模式');
        // 采集不在这里重启：模型要图会调 peek，那条路会按用户原来的 region/清晰度起管道。
      }

      // ② 采集自己停了（源断了、ffmpeg 挂了）。
      //    **续命放在这之前**：静态画面下 60 秒不出图，宽限期会把采集收走，
      //    那时 `!running` 是"没人来取"而不是"坏了"，不能当成停。
      const st = runner.status();
      const alive = runner.touch?.() ?? st.running;
      /**
       * 采集已经停了：**最多再给两拍**把队列里剩下的图报出来，然后收工。
       *
       * 以前这里是 `!alive && !st.pending` —— 只要还有没取走的图就永远不自杀。
       * 文件回放一次能塞几十张进去，循环就被这些"永远取不完"的 pending 吊住，
       * 模型每拍被叫醒一次，用户看到的就是"一直弹有新画面、关窗都停不干净"。
       */
      if (alive) {
        deadTicks = 0;
        // 采集回来了（模型 peek 会把管道重新拉起来），暂停标记到此为止
        pausedByListen = false;
      } else if (!pausedByListen) {
        deadTicks += 1;
        if (!st.pending || deadTicks > 2) { stop('capture-stopped'); return; }
      }

      /**
       * 采集已经停了：**只允许第一拍把已经攒好的那张报出去**，之后不再产生唤醒。
       *
       * 社区实报：capture-stopped 之后还连收几条「有新画面了」，而且文案里
       * 「上一句 say N 秒前」的 N 越来越大 —— 因为 `lastSaidNote()` 是拿 `Date.now()`
       * 实时算的，采集都没了还在造新提词，那句话当然是"过期"的。
       * 队列里剩下的图仍然能 `peek` 到（那条路不经过这里），所以不报不会丢东西。
       */
      if (!alive && deadTicks > 1) return;

      // ③ 有人在阻塞等的时候，整条叫醒路径都让开 —— 那一轮本来就还没结束，
      //    `followup` 投进去只会排队到这一轮之后，纯属插队无效还容易串话。
      if (waiting) return;

      // ④ 用户插话 —— **优先于一切**，不等攒满一张、不看队列深度，
      //    **也不受自动唤醒的冷却限制**。
      //
      //    3 秒冷却本来是给"机器自己叫醒"防刷屏用的。套在人的输入上就是画蛇添足：
      //    你说完一句、3 秒内又补一句，第二句被静默吞掉，用户侧的感受是"它聋了"，
      //    然后那句话以"排队消息"的形式堆在宿主里 —— 比不叫醒还糟。
      //
      //    唯一的例外是**同一拍连发**（500ms 内刚叫醒过）。那种情况下面必然在排队，
      //    放回队里等下一拍，不丢。
      if (queue.length) {
        if (Date.now() - lastWakeAt < INTERJECT_GAP_MS) return;
        const said = queue.shift();
        noteInterjected(said);          // 记待回执：没带 say 回的话下一轮会被顶
        const text = `[看屏幕·用户插话] 「${said}」\n`
          + '**先说话，再干活** —— 用 `say` 回他（普通回复他一个字都看不到，也不会被念）。'
          + '要同时看一眼就调 `see_now({action:"peek"})`，图马上给你。';
        await wake(text);
        return;
      }

      // ④.5 没人在看就收工（社区实报「卡读图循环」的止血线，判据见 shouldGoIdle）
      //      **但窗还开着的时候只降级、不收工** —— 那扇窗还在屏幕上，用户随时可能打字，
      //      把循环整个拆掉等于把他的输入扔进黑洞（见 mode 的说明）。
      const winOpenNow = windowAlive();
      const act = idleAction({
        idle: shouldGoIdle({
          wakesSinceUser, lastUserAt, windowOpen: winOpenNow,
          maxWakes: tuning?.maxAutonomousWakes,
          idleStopMs: tuning?.idleStopMs,
        }),
        windowOpen: winOpenNow,
      });
      if (act === 'listen') { enterListen(); return; }
      if (act === 'stop') { stop('idle'); return; }

      // ⑤ 攒够一张**新的**图了 —— 这才是常态唤醒。
      // **必须按出图序号判重**：以前只看 `pending > 0`，而模型要是没调 `peek`
      // （比如它直接回了一句话），pending 一直是 1 —— 于是每 3 秒叫一次，
      // 一路叫到用户把它关掉。`pending` 只说明"队列里有一张"，不说明"是新的"。
      const pending = Number(st.pending) || 0;
      if (pending > 0 && lastPending === 0) pendingPulse += 1;
      lastPending = pending;
      const sheetSeq = Number(st.sheets ?? st.stats?.sheets ?? 0);
      /**
       * **攒够 `wakeBatch` 张才叫。**
       *
       * `wakeBatch: 1` 就是原来的行为（有新图就叫）。> 1 是超省模式：叫一次交一批，
       * 模型一轮看完，不必为每张图各重过一遍上下文。
       *
       * 判据必须是 `>= batch` 而不是 `> 0`：后者会在第 1 张就叫，攒第二、三张的
       * 时间里模型已经看完一轮了 —— 队列压得住也没用，唤醒次数根本没减少。
       */
      const batch = Math.max(1, Math.trunc(tuning?.wakeBatch) || 1);
      const key = pending >= batch ? (sheetSeq > 0 ? `#${sheetSeq}` : `p${pendingPulse}`) : null;
      if (!key || key === lastKey) return;
      // ⑤.1 节奏：既不能比 wakeMinGapSec 更密，也不能在上一句还没说完时插嘴。
      //      "上一句说多久，就等多久"——上一句 6 秒，下一次最早在说完之后（+气口），
      //      而不是从"叫醒那一刻"起算的固定 8 秒。
      const nextAt = nextProactiveAt({
        lastWakeAt,
        minGapMs: Math.max(0, wakeMinGapSec) * 1000,
        speechAt: followSpeech ? lastSpeechAt : 0,
        speechMs: followSpeech ? lastSpeechMs : 0,
        mode: pacingMode,
      });
      if (Date.now() < nextAt) return;   // 下一拍再来
      // ⑤.1.6 上一条叫醒还没被接住就不要再叫 —— 宿主会把这些叫醒排队，
      //        模型没来得及回应时，用户屏幕上会积一串「有新画面了」。
      if (lastWakeOk && lastWakeAt > lastAckAt) {
        // 只拦**成功**的那一条：叫醒失败还要按原来的重试/连续失败逻辑走。
        // 超过 unackedStopMs 还没接住 → 模型那一轮压根没用这个工具（只回了文本），
        // 再叫只会继续刷屏。整个收工。
        if (Date.now() - lastWakeAt > unackedStopMs) { stop('wake-unacked'); return; }
        return;
      }

      // 叫醒了才算"这张已经叫过"。**失败不能记账**：记了的话下一拍看到 key 没变
      // 就不再重试，连续失败计数永远到不了上限 —— 于是"叫不醒"既不会重试也不会停。
      const text = scene
        ? '[看屏幕·逐场景] 换画面了。\n'
          + '调 `see_now({action:"peek"})` 拿这一张（逐帧模式下它只有一帧、铺满整张图），'
          + '然后用 `say` **一句话**说清现在是什么场景 —— 用户要的就是"换一次说一次"，别省略。\n'
          + '一句话就行：说清画面里是什么，不要展开成段落，也不要重复上一句。'
          + lastSaidHint() + muteNote()
        : `[看屏幕] 有新画面了（这一张攒了 ${st.secondsSinceWake ?? '?'} 秒）。\n`
          + '调 `see_now({action:"peek"})` 拿图看一眼，然后：值得说就用 `say` 说一句，'
          + '不值得说就什么都别做（沉默是允许的，别为了刷存在感而说话）。'
          + lastSaidHint() + muteNote();

      /**
       * ⑤.2 **先把这一张占住，再叫醒。**
       *
       * 文案让模型"调 `peek` 拿这一张"，可从叫醒到它真的 peek 隔着 1~3 秒
       * （宿主冷启动更久）。这期间只要有一条路径把队列取空（另一条 `watch`、
       * 插话截断、换管线），模型醒了就是空手 —— 社区实报的"110 秒叫了 6 次、
       * 多数唤醒没带图"就是这么来的（图确实出了，出在了别人手里）。
       *
       * 占住之后这张已经不在队列里，`peek` 优先给预留的（见 `runner.reserveSheet`）。
       * 占不到 = 这一张在叫醒之前就被取走了，**这一拍不叫** —— 叫醒一个空手的人
       * 只会让它白跑一轮、还看不见东西，比不叫更糟。
       *
       * ⚠️ 这里挪的只是**一张已经拼好的图**：采集、打分、出图一概照旧，
       * "停的只是叫醒，采集和打分从不停"这条不变量没动。
       */
      const held = typeof runner.reserveSheet === 'function' ? runner.reserveSheet() : true;
      if (!held) return;

      const ok = await wake(text);
      if (ok) { lastKey = key; wakesSinceUser += 1; }
      // 叫醒失败要把预留放回队列 —— 不然这一张就被我们自己吞了
      // （下一拍 `key` 没变还会重试，所以**不能**记账成"叫过了"）。
      else if (typeof runner.releaseSheet === 'function') runner.releaseSheet();
    },
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    ticker.dispose();
    try { offSpeech(); } catch { /* 已经退订 */ }
  }

  return {
    dispose,
    /** 任何一次 `see_now` 调用都算"接住了上一条叫醒"。 */
    noteActivity() { lastAckAt = Date.now(); },
    stopped: () => stopReason !== null,
    state: () => ({
      stopped: stopReason !== null,
      // 'active' 在正常看；'listen' = 只剩耳朵（采集停了，但窗里打字仍然收得到）
      mode,
      reason: stopReason,
      session: owner,
      wakes: wakeCount,
      wakeFailures,
      lastWakeAt: lastWakeAt || null,
      lastAckAt: lastAckAt || null,
      awaitingAck: lastWakeAt > lastAckAt,
      lastWakeOk,
      lastSheet: lastKey,
      // 节奏诊断：下一次主动唤醒最早落在什么时候、为什么被推迟
      lastSpeechMs: lastSpeechMs || null,
      nextWakeAt: nextProactiveAt({
        lastWakeAt,
        minGapMs: Math.max(0, wakeMinGapSec) * 1000,
        speechAt: followSpeech ? lastSpeechAt : 0,
        speechMs: followSpeech ? lastSpeechMs : 0,
        mode: pacingMode,
      }) || null,
    }),
  };
}
