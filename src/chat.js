/**
 * chat.js — 和悬浮窗共用的那一条文本流（`chat.jsonl`）。
 *
 * 为什么是文件而不是别的：**阻塞期间宿主的输入框送不进这个调用**（实测宿主的消息
 * 是事后补写到会话文件里的）。而这个 jsonl 是我们自己 append 的，写盘即时 ——
 * 阻塞循环每 150ms 增量读一次就能看见。
 *
 * 和 watch 那边**分开一个文件**：`~/.dsh/see-now/chat.jsonl`。
 * 共用一个的话，两边的话会串进同一个窗，而且谁都不知道哪句是对谁说的。
 *
 * 只做三件事：写一条、增量读、判断"这句是不是用户刚说的"。HTTP 服务一律不要 ——
 * 悬浮窗本来就直接写文件，那个服务是给浏览器兜底和浏览器扩展上报位置用的，我们都不需要。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { emitSpeech } from './speech.js';

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * 用户按了静音吗（`watch-window.json` 的 `status.muted`，悬浮窗的「♪」写的）。
 *
 * 为什么在 chat.js 里自己读盘、不 import window.js：`window.js` 反过来 import
 * 了这里的 `chatDir()`（拉起窗口时要传缓存目录），互相 import 会绕成环。
 * 这个文件每次"说一句话"才读一次，几十字节的 JSON，代价可以忽略。
 */
/**
 * 音量 0~100（用户在小窗顶栏那条竖音量条上拖的）。读不到就当 100。
 *
 * 和 `mutedNow` 一样直接读文件、不从 window.js 借：chat → window → chat 会绕成
 * 循环 import，ESM 里那种环在"用的时候还没初始化"时才炸，最难查。
 */
export function volumeNow(env = process.env) {
  try {
    const cfg = JSON.parse(readFileSync(join(dshHome(env), 'watch-window.json'), 'utf8'));
    const raw = cfg?.status?.volume;
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
    // 老配置只有 muted
    return cfg?.status?.muted === true ? 0 : 100;
  } catch {
    return 100;
  }
}

export function mutedNow(env = process.env) {
  try {
    const cfg = JSON.parse(readFileSync(join(dshHome(env), 'watch-window.json'), 'utf8'));
    const raw = cfg?.status?.volume;
    const n = Number(raw);
    if (Number.isFinite(n)) return n <= 0;
    return cfg?.status?.muted === true;
  } catch {
    return false;
  }
}

/**
 * 送图给模型时贴的那一句"用户静音了"（没静音就是空串）。
 *
 * 为什么非要告诉它：模型看不见播放器，只会照常写"我念给你听""听见没"这种句子；
 * 用户按了静音，那句话就变成一句谎 —— 他根本没听见。
 */
export function muteNote(env = process.env) {
  return mutedNow(env)
    ? '（用户按了静音：你说的话只出现在小窗里，**不会念出来** —— 别写"我念/我说给你听"。）\n'
    : '';
}

export function chatDir(env = process.env) {
  return join(dshHome(env), 'see-now');
}

export function chatFile(env = process.env) {
  return join(chatDir(env), 'chat.jsonl');
}

/**
 * 给悬浮窗发一条 `control` 事件（插件 → 窗口，`window-events.jsonl`）。
 *
 * 窗口没开也照写：它启动时会回放最后 60 条，control 事件照样执行 ——
 * 所以"按麦克风快捷键 → 先写事件再拉窗"的顺序能保证窗口一出来就切录音。
 *
 * @returns {boolean} 写没写进去
 */
export function windowControl(action, value = null, env = process.env) {
  try {
    appendFileSync(join(chatDir(env), 'window-events.jsonl'),
      `${JSON.stringify({
        type: 'control',
        action: String(action),
        at: Date.now(),
        ...(value !== null ? { value } : {}),
      })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 追加一条。`role` 只有两种：`assistant`（模型说的）和 `user`（用户打的/说的）。 */
export function appendChat(role, text, env = process.env) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const file = chatFile(env);
  mkdirSync(chatDir(env), { recursive: true });
  const entry = { role, text: t, at: Date.now() };
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * **唯一出口**：往悬浮窗写一句"说给用户的话"，并且**一定经过语音播报**。
 *
 * 为什么必须收成一个入口（照搬陪看的教训）：以前有两条写盘的路 ——
 * 一条写+发声，一条只写。于是"补写的话"在窗口里看得见、却一点声都没有，
 * 用户第一反应就是"为什么你写的字没有声音"。凡是**说给用户的话**都走这里：
 * 写盘和发声是同一次调用的两个副作用，谁也离不开谁。
 *
 * `speak: false` 只留给**诊断行**（"窗没开起来"这类），那些是给眼睛看的，不该念出来。
 *
 * @param {'assistant'|'meta'} role
 * @param {string} text
 * @param {{speak?:boolean, env?:object}} [o]
 */
export function appendSpoken(role, text, { speak = true, env = process.env } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const entry = appendChat(role, clean, env);
  // 只有"说给用户的话"才记：`meta`（诊断行）不该被当成"你上一句说过什么"
  if (role === 'assistant') lastSaid = { text: clean, at: Date.now() };
  // 静音时**只跳发声**：字照样写进 chat.jsonl —— 用户要的是"别出声"，不是"别说话"。
  // `origin: 'chat'` 告诉展示层"这条已经在流里了，别再写第二遍"
  if (speak) emitSpeech({ at: null, text: clean, state: 'due', origin: 'chat', volume: volumeNow(env) });
  // **直达队列**：绕开总线/订阅/缓存，语音脚本自己 watch 这个文件念。
  // 即使总线因为模块双实例之类的原因蒸发事件，声音也有第二条路。
  if (speak && !mutedNow(env)) {
    try {
      appendFileSync(join(dshHome(env), 'say-queue.jsonl'),
        JSON.stringify({ text: clean, volume: volumeNow(env), at: Date.now() }) + '\n', 'utf8');
    } catch { /* 写不进不影响主路 */ }
  }
  return entry;
}

/**
 * 上一条**说给用户的话**（`{text, at}`；没说过是 null）。
 *
 * 为什么要有它：实时看屏幕时模型每 20~60 秒被叫醒一次，每次都在"现场想一句"，
 * 于是同一句感慨会被说两遍（实测「我先看一眼你屏幕上是什么」连着说了两次，
 * 用户当场就问"你为什么重复"）。把上一句带回给它，比让它自己回忆便宜也可靠 ——
 * 那个上下文可能已经被压缩掉了。
 */
let lastSaid = null;

/**
 * 「你上一句说过什么」，给工具结果和唤醒文案共用。
 *
 * 实时看屏幕是**同一个画面被反复看**：模型每次被叫醒都在现场想一句，
 * 于是同一句感慨会被说两遍（实测「我先看一眼你屏幕上是什么」连着说了两次）。
 * 把上一句带回来，比让它自己回忆可靠 —— 那段上下文可能已经被压缩掉了。
 *
 * 只写一份的原因：工具结果和循环唤醒是两条入口，各写一套就会出现
 * "watch 那条提醒了、peek 那条没提醒"这种只在某条路上复现的重复。
 *
 * @param {{maxAgeSec?:number, clipLen?:number}} [o]
 * @returns {string} 没有上一句（或太久以前）就是空串
 */
export function lastSaidNote({ maxAgeSec = 300, clipLen = 60 } = {}) {
  if (!lastSaid?.text) return '';
  const age = Math.round((Date.now() - lastSaid.at) / 1000);
  if (age > maxAgeSec) return '';
  const t = String(lastSaid.text).replace(/\s+/g, ' ').trim();
  const clip = t.length > clipLen ? `${t.slice(0, clipLen)}…` : t;
  return `\n（你上一句说的是「${clip}」，${age} 秒前 —— 别重复它。）`;
}

/** 最近一次 `say` 的原文与时间（镜像正文时用来去重：那句话已经进过窗了）。 */
export function lastSaidText() {
  return lastSaid ? { text: lastSaid.text, at: lastSaid.at } : null;
}

/**
 * **进程共享**的增量探测器。
 *
 * 为什么必须共享（照搬陪看的教训）：
 *   ① `makeChatWatcher()` 以"创建时的位置"为基线 —— 每次等待都新建一个的话，
 *      **模型思考期间**用户说的话会落在两次等待的缝隙里，谁都不报，永远丢掉；
 *   ② 阻塞等待和常驻循环都要看这条通道。各自建一个，同一条消息会被两边各吃一次
 *      （重复唤醒）；共享之后才谈得上"谁先用"。
 */
let sharedWatcher = null;
export function chatWatcherShared(env = process.env) {
  if (!sharedWatcher) sharedWatcher = makeChatWatcher(env);
  return sharedWatcher;
}

/**
 * 现在有几个地方**正阻塞着等用户说话**。
 *
 * 为什么必须有这个计数：聊天框是**一个消费型通道**，poll 一次就把它标成已读。
 * 阻塞等待和常驻循环共用同一个 watcher，谁先 poll 谁拿到。而循环那边拿到后走的是
 * `followup()` —— 会话正卡在工具调用里等结果时，投进去的消息要**等这一轮结束**才会被处理，
 * 所以它接不住"从等待里出来"这件事。实测（陪看 2026-10-31）：用户在悬浮窗说话，
 * 循环把话吃了、`followup` 排进去，等待里的 `poll()` 再也看不见它 ——
 * 表现就是"我在窗口里说话，它一动不动"。
 *
 * 所以：**有等待者时，循环不许碰这个通道**。
 */
let chatWaiters = 0;

/** 进入"我在等用户说话"的状态，返回退出函数（务必 finally 里调） */
export function enterChatWait() {
  chatWaiters += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    chatWaiters = Math.max(0, chatWaiters - 1);
  };
}

/** 有几个等待者（给循环判断"这条通道现在归谁"） */
export function chatWaiterCount() {
  return chatWaiters;
}

/**
 * 增量 watcher：只看上次之后新写进来的字节。
 *
 * **不许整份重读**：一场两小时几千条，每 150ms 全解析一遍会把 CPU 吃满。
 * 末尾可能是半行（写盘还没写完），读不全就留到下一次。
 *
 * @returns {() => Array<{role:string,text:string,at:number}>} 每次调用返回"上次之后的新条目"
 */
export function makeChatWatcher(env = process.env) {
  const file = chatFile(env);
  let off = 0;
  let primed = false;

  return function poll() {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // 文件还不存在：**也要 prime 在 0 位**，否则用户的第一句话会创建这个文件，
      // 而那时 `primed` 还是 false → 直接把整份（就那一句）当历史跳过。
      // 这是实测踩到的：第一次插话永远听不见。
      if (!primed) { primed = true; off = 0; }
      return [];
    }
    if (!primed) {
      // 文件存在：只记位置，不把历史消息当成"刚说的"
      off = size;
      primed = true;
      return [];
    }
    if (size <= off) { off = Math.min(off, size); return []; }
    const len = size - off;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = openSync(file, 'r');
      readSync(fd, buf, 0, len, off);
    } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }

    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return [];                 // 只有半行，等下一次
    off += Buffer.byteLength(text.slice(0, cut + 1), 'utf8');

    const out = [];
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out;
  };
}
