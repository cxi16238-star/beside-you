/**
 * speech.js — 声音**事件总线**：核心只发事件，永不发声。照搬 `dsh-watch-together/src/speech-bus.js`。
 *
 * 只回答三个问题：谁在听（`onSpeech`）、有没有人真会出声（`speechSubscribers`）、
 * 发生了什么事（`emitSpeech`）。里面没有一行引擎代码 —— SAPI、edge-tts、ffplay
 * 都属于某个平台上的某种实现，不该长在核心身上。
 *
 * 状态有四种：
 *
 *   `scheduled`  只是清单（这句打算在 at 念），不是"现在念"
 *   `due`        核心发出：**该念了**
 *   `spoken`     适配器发出：**声音真的出来了**（开始播放的那一瞬）
 *   `skipped`    适配器发出：**这一句不念了**（排队太久、追不上画面）
 *
 * 为什么要有 `spoken`：`due` 到"出声"之间还隔着一整套合成 —— edge-tts 一次网络往返
 * 加 ffplay 启动，短句也要 0.6~2 秒。展示层若认 `due` 就把字摆出来，用户看到的是
 * "字先到、声音后到"。**该挪的是字，不是声音**（声音一挪就离画面远去），所以展示层等 `spoken`。
 */

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 只认这四种；写错了按 `due` 处理（容错方向要护住"会念"） */
function normalizeState(s) {
  if (s === 'scheduled') return 'scheduled';
  if (s === 'spoken') return 'spoken';
  if (s === 'skipped') return 'skipped';
  return 'due';
}

/**
 * 订阅者。`voice: true` = **会真的出声**（音频适配器）；`voice: false` = 只是看（日志）。
 *
 * 这个区分很要紧：靠"有没有会出声的订阅者"决定要不要等 `spoken` 再写字。
 * 只做展示的订阅者不该替声音做这个决定。
 *
 * @type {Map<(e:object)=>void, {voice:boolean}>}
 */
// **总线状态挂到 globalThis 上**：同一个包里这个模块可能被加载成两份实例
// （voice.js 一份、chat.js 一份），各自的模块级 Map 互不相通 —— 那就会出现
// "适配器挂上了、status 显示 1 个订阅者，但 emitSpeech 里 subscribers.size === 0"
// 的诡异现象（实测踩到过：声音永远不出来）。用全局单例保证只有一条总线。
const BUS = (globalThis.__dshSpeechBus ??= { subscribers: new Map(), lastEvent: null, seq: 0 });
const subscribers = BUS.subscribers;

/**
 * 订阅"某句话该念了"。返回**退订函数**（不是 index，避免调用方自己记编号）。
 *
 * @param {(event:{seq:number,at:number|null,text:string,state:string,origin?:string}) => void} handler
 * @returns {() => boolean} 退订；返回是否真的摘掉了
 */
export function onSpeech(handler, { voice = true } = {}) {
  if (typeof handler !== 'function') throw new TypeError('onSpeech(handler) needs a function');
  subscribers.set(handler, { voice: Boolean(voice) });
  return () => subscribers.delete(handler);
}

/** **会出声的**订阅者数量。决定"要不要等声音真的出来再写字"。 */
export function speechSubscribers() {
  let n = 0;
  for (const s of subscribers.values()) if (s.voice) n += 1;
  return n;
}

/** 最近发出的一条事件（排查"它到底发没发"用，不参与逻辑） */
export function lastSpeech() {
  return BUS.lastEvent;
}

/**
 * 广播一条。**没有订阅者时是空操作**（返回 0），这是零依赖路径的保证。
 *
 * 单个订阅者抛异常不会影响其他人，也不会打断看屏幕 —— 声音挂掉不该让画面跟着停。
 *
 * @returns {number} 实际送达的订阅者数量
 */
export function emitSpeech(event) {
  // 调试：确认广播是否被调用、有几个订阅者（定位用，稳定后可删）
  try {
    appendFileSync(join(homedir(), '.dsh', 'speech-emit.log'),
      `${new Date().toISOString()} state=${String(event?.state ?? '-')} subs=${subscribers.size}\n`);
  } catch { /* 忽略 */ }
  if (subscribers.size === 0) return 0;
  BUS.seq += 1;
  const payload = Object.freeze({
    seq: BUS.seq,
    at: Number.isFinite(event?.at) ? Number(event.at) : null,
    text: String(event?.text ?? ''),
    state: normalizeState(event?.state),
    // `origin: 'chat'` = 这条已经被写进聊天流了，展示层不要再写一遍
    ...(event?.origin ? { origin: String(event.origin) } : {}),
    /**
     * 适配器知道的**音频真实时长**（毫秒）。
     *
     * 只给 `spoken` 用：`due` 那一刻还没有音频，估不出来。拿到之后
     * `markSpeaking()` 就不再按字数猜了 —— 字数估算对慢语速会低估、对快语速会高估，
     * 两头都出问题（issue #33：慢的会自激、快的会多聋几秒）。
     */
    ...(Number.isFinite(Number(event?.durationMs)) ? { durationMs: Number(event.durationMs) } : {}),
  });
  BUS.lastEvent = { ...payload, emittedAt: Date.now() };
  let delivered = 0;
  for (const fn of [...subscribers.keys()]) {
    try { fn(payload); delivered += 1; } catch { /* 订阅者自己的事 */ }
  }
  return delivered;
}

/**
 * 「声音真的出来了」—— **由声音适配器**在开始播放的那一瞬发。
 *
 * 必须比播放**略早或同时**，不能晚：展示层收到就写盘，所以上报点选"开始播放之前"，
 * 而不是"播完"。发不出去也无所谓：展示层有兜底，字不会因为适配器没上报就消失。
 */
export function emitSpoken(event) {
  return emitSpeech({ ...event, state: 'spoken' });
}

/** 仅测试/卸载用：清空订阅者与最近事件，避免用例之间互相污染 */
export function __resetSpeech() {
  subscribers.clear();
  BUS.lastEvent = null;
  // ⚠️ 序号挂在 BUS 上，不是模块里的裸变量。原来这里写的是 `seq = 0`，
  // ESM 严格模式下那是 ReferenceError（未声明变量赋值），一调就抛。
  BUS.seq = 0;
}
