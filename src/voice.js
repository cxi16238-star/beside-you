/**
 * voice.js — 按路径挂一个外部声音适配器。**核心不内置任何引擎**。
 * 照搬 `dsh-watch-together/src/voice-adapter.js`，只做三件事：
 * 从配置读出"装哪个适配器"、dynamic import 它、记住 attach(api) 拿到的 detach。
 * 失败一律不抛 —— 声音是可选能力，装坏了最多没声音，不能让看屏幕起不来。
 *
 * ```json
 * // ~/.dsh/voice.json —— **和陪看共用同一份配置**
 * { "adapter": "D:/code/my-voice.mjs" }
 * ```
 *
 * 共用配置是有意的：用户装一个适配器，两个插件都能用。代价是同一时刻只该有一个在说话，
 * 所以两边都用同一个 `~/.dsh/tts.json` 音色，引擎串行由适配器自己保证。
 *
 * 适配器模块导出 `attach(api)`（或 default 导出同名函数），`api` 是
 * `{ onSpeech, speechSubscribers, emitSpeech, emitSpoken, lastSpeech }`。
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { emitSpeech, emitSpoken, lastSpeech, onSpeech, speechSubscribers } from './speech.js';

/** 同一模块按 owner 隔离；未传 owner 时保留旧的全局复用方式。 */
const adapters = new Set();
const configuredRequests = new Map();
const DETACH_TIMEOUT_MS = 1000;
let lastError = null;

function adapterOwner({ owner, scope } = {}) {
  return owner === undefined ? scope : owner;
}

/** 先退订和中止，再有界等待旧适配器返回的 detach。迟到的 attach 也走这里。 */
function closeAdapter(record, cancel = true) {
  if (record.closed && !record.detach) return record.closing ?? Promise.resolve();
  record.closed = true;
  if (cancel) record.cancel();
  record.removeAbort?.();
  for (const off of record.subscriptions) off();
  record.subscriptions.clear();
  record.controller.abort();
  const detach = record.detach;
  record.detach = null;
  if (!detach) {
    adapters.delete(record);
    return Promise.resolve();
  }
  let timer;
  const work = Promise.resolve().then(detach).catch((e) => {
    try { record.log(`[voice] detach failed: ${record.name}: ${String(e?.message ?? e)}`); } catch { /* 日志不影响清理 */ }
  });
  record.closing = Promise.race([
    work,
    new Promise((resolve) => { timer = setTimeout(resolve, DETACH_TIMEOUT_MS); }),
  ]).finally(() => {
    clearTimeout(timer);
    adapters.delete(record);
  });
  return record.closing;
}

/**
 * 读 `~/.dsh/voice.json` 里的 `adapter`，或者环境变量 `DSH_VOICE_ADAPTER`。
 * **只读"装哪个适配器"这一个字段** —— 音色、语速、引擎路径都是适配器自己的事。
 */
export function configuredVoiceAdapter(env = process.env) {
  const fromEnv = String(env.DSH_VOICE_ADAPTER ?? '').trim();
  if (fromEnv) return fromEnv;
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8'));
    const spec = String(cfg?.adapter ?? '').trim();
    if (spec) return spec;
  } catch { /* 没配就算了：这是可选能力 */ }
  return null;
}

/**
 * `voice.json` 里给适配器的 `options`（对象，可选）。
 *
 * **为什么加这个**：核心不内置引擎，引擎路径/模型目录该由用户决定；但以前除了
 * "用哪个适配器"没有任何透传入口，适配器只能把模型路径写死在自己代码里 ——
 * 用户换一个自己训的模型就得改别人的源码（2026-11-03 社区反馈原话：
 * "语音写死了一个地方去找那个模型，我明明自己搞过语音模型，能不能支持自定义"）。
 *
 * 现在 `{ "adapter": "...", "options": { "model": "D:/my/model" } }` 会原样交给
 * `attach(api, options)`。**老适配器不受影响**：它们本来就只接一个参数。
 */
export function configuredVoiceOptions(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8'));
    const opts = cfg?.options;
    return opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : null;
  } catch { return null; }
}

/**
 * `D:/code/x.mjs`、`./x.mjs`、`/opt/x.mjs` 当路径；`my-voice-adapter` 当包名。
 *
 * 文件路径带 mtime 查询串：ESM 的 `import()` 按 URL 缓存模块，适配器文件改完之后
 * **不重启宿主就永远不会重新求值**（实测：attached 10 次、loaded 只有 9 次，
 * 改文件全白改）。查询串只影响 import 本身，record.name 匹配用的还是原始 spec。
 */
function toImportSpecifier(spec) {
  const s = String(spec).trim();
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(s)) {
    const href = pathToFileURL(s).href;
    try {
      return `${href}?mtime=${statSync(s).mtimeMs}`;
    } catch { /* 文件还没落地就让 import 自己报错 */ }
    return href;
  }
  return s;
}

/** 挂载失败或已卸载后，迟到的订阅和回执也不会重新接入总线。 */
function trackedApi(record) {
  const handlers = new WeakMap();
  return {
    signal: record.controller.signal,
    speechSubscribers,
    lastSpeech,
    emitSpeech: (event) => record.closed ? 0 : emitSpeech(event),
    emitSpoken: (event) => record.closed ? 0 : emitSpoken(event),
    onSpeech(handler, options) {
      if (record.closed) return () => false;
      if (typeof handler !== 'function') throw new TypeError('onSpeech(handler) needs a function');
      // 不再按 record.closed 吞事件：卸载时 off() 会把订阅删掉，这层只会误杀活回调
      if (!handlers.has(handler)) handlers.set(handler, (event) => handler(event));
      const off = onSpeech(handlers.get(handler), options);
      let active = true;
      const trackedOff = () => {
        if (!active) return false;
        active = false;
        record.subscriptions.delete(trackedOff);
        return off();
      };
      record.subscriptions.add(trackedOff);
      return trackedOff;
    },
  };
}

/**
 * 最后一次挂载失败的原因。
 *
 * 为什么留着：`status` 要能回答"配了适配器为什么没声音"。没有这个字段，
 * 现场只能靠猜（"是不是没重启？"），而真实原因往往是 import 路径写错了、
 * 或者适配器 `attach` 里探测引擎时抛了。
 */
export function lastVoiceError() {
  return lastError;
}

/**
 * 挂载外部适配器；owner（兼容别名 scope）隔离插件实例，signal 只中止本实例。
 * options 透传给适配器 attach(api, options)。
 * 旧的 attach(api) → detach 契约不变，api.signal 可供适配器提前取消播放。
 *
 * @param {string} spec 模块名或文件路径
 * @param {{log?: (msg:string)=>void, owner?: unknown, scope?: unknown, signal?: AbortSignal, options?: object|null}} [options]
 * @returns {Promise<{ok:boolean, reason?:string, cached?:boolean, name?:string}>}
 */
export async function loadVoiceAdapter(spec, options = {}) {
  const { log = () => {}, signal, options: voiceOptions = null } = options;
  const raw = String(spec ?? '').trim();
  if (!raw) { lastError = 'empty-specifier'; return { ok: false, reason: 'empty-specifier' }; }
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  const owner = adapterOwner(options);
  let record = [...adapters].find((entry) => !entry.closed && entry.name === raw && entry.owner === owner);
  if (record) {
    bindAbort(record, signal);
    return record.ready ? { ok: true, cached: true, name: raw } : record.result;
  }

  record = { name: raw, owner, log, subscriptions: new Set(), controller: new AbortController(), detach: null, closed: false };
  const cancelled = new Promise((resolve) => { record.cancel = () => resolve({ ok: false, reason: 'aborted' }); });
  adapters.add(record);
  bindAbort(record, signal);
  const work = (async () => {
    let mod = null;
    try {
      mod = await import(toImportSpecifier(raw));
    } catch (e) {
      const reason = `import failed: ${String(e?.message ?? e).slice(0, 200)}`;
      try { log(`[voice] ${raw}: ${reason}`); } catch { /* ignore */ }
      lastError = reason; return { ok: false, reason };
    }
    const attach = mod?.attach ?? mod?.default?.attach ?? mod?.default;
    if (typeof attach !== 'function') {
      const reason = 'no attach function exported';
      try { log(`[voice] ${raw}: ${reason}`); } catch { /* ignore */ }
      lastError = reason; return { ok: false, reason };
    }

    try {
      const detach = await attach(trackedApi(record), voiceOptions ?? {});
      record.detach = typeof detach === 'function' ? detach : null;
      if (record.closed) {
        await closeAdapter(record);
        return { ok: false, reason: 'aborted' };
      }
      record.ready = true;
      const name = String(mod?.adapterName ?? raw).split(/[\\/]/).filter(Boolean).pop() || raw;
      try { log(`[voice] adapter attached: ${name}`); } catch { /* ignore */ }
      lastError = null;
      return { ok: true, name };
    } catch (e) {
      const cancelled = record.closed;
      await closeAdapter(record, false);
      if (cancelled) return { ok: false, reason: 'aborted' };
      const reason = `attach failed: ${String(e?.message ?? e).slice(0, 200)}`;
      try { log(`[voice] ${raw}: ${reason}`); } catch { /* ignore */ }
      lastError = reason;
      return { ok: false, reason };
    }
  })();
  record.result = Promise.race([work, cancelled]);
  return record.result;
}

/** 缓存命中时也接上当前生命周期的 signal。 */
function bindAbort(record, signal) {
  if (!signal) return;
  record.removeAbort?.();
  const onAbort = () => { void closeAdapter(record); };
  if (signal.aborted) { onAbort(); return; }
  signal.addEventListener('abort', onAbort, { once: true });
  record.removeAbort = () => signal.removeEventListener('abort', onAbort);
}

/** 按配置挂载，透传 owner/scope 和 signal；没配就是 no-op。 */
export async function attachConfiguredVoice({ env = process.env, ...options } = {}) {
  const spec = configuredVoiceAdapter(env);
  if (!spec) return { ok: false, reason: 'not-configured' };
  const voiceOptions = options.options ?? configuredVoiceOptions(env);
  return loadVoiceAdapter(spec, { ...options, options: voiceOptions });
}

/**
 * 当前配置的**指纹**：适配器路径 + `tts.json` 的**内容摘要**。
 *
 * 为什么需要指纹：适配器在 `attach` 那一刻把 `tts.json` 读进闭包，之后改文件它**看不见**。
 * 有了指纹，每次调用就能自己判断"配置变没变"，变了就重挂 —— 不用重启 DSH。
 * 核心在这里只看"变没变"，不解释内容：音色、语速都是适配器自己的事。
 *
 * 为什么用内容摘要而不是 mtime：mtime 的分辨率只到毫秒，同一毫秒内两次同长度的写入
 * 会被判成没变 —— 这个坑单测里当场踩到过。这个文件只有几十字节，读一遍比 stat 贵不了多少。
 */
export function voiceSignature(env = process.env) {
  const spec = configuredVoiceAdapter(env);
  if (!spec) return '';
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  let stamp = 'none';
  try {
    const buf = readFileSync(join(home, 'tts.json'));
    stamp = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch { /* 没有 tts.json：用适配器自己的默认值 */ }
  // `options` 也算进指纹：它是**挂载时**读进闭包的，改了不重挂就等于没改
  let opts = '';
  try { opts = JSON.stringify(configuredVoiceOptions(env) ?? null); } catch { opts = '?'; }
  // 适配器文件本身的 mtime 也进指纹：改完文件，下次调用就重挂（配合 toImportSpecifier
  // 的 `?mtime=` 缓存失效，真正实现"改适配器不用重启宿主"）。只对路径型 spec 生效。
  let src = '';
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/.test(spec)) {
    try { src = `:${statSync(spec).mtimeMs}`; } catch { src = ':?'; }
  }
  return `${spec}|${stamp}|${opts}${src}`;
}

/** 每次调用热读配置；换配置或删配置只卸本 owner，迟到请求不覆盖新配置。 */
export async function ensureConfiguredVoice({ env = process.env, ...options } = {}) {
  const owner = adapterOwner(options);
  if (options.signal?.aborted) return { ok: false, reason: 'aborted' };
  const spec = configuredVoiceAdapter(env);
  const signature = voiceSignature(env);
  const voiceOptions = options.options ?? configuredVoiceOptions(env);
  const pending = configuredRequests.get(owner);
  if (pending?.signature === signature) return pending.work;
  const current = [...adapters].find((entry) => !entry.closed && entry.owner === owner && entry.name === spec && entry.signature === signature);
  if (current && !pending) return loadVoiceAdapter(spec, { ...options, owner, options: voiceOptions });

  const request = { signature };
  configuredRequests.set(owner, request);
  request.work = (async () => {
    await Promise.all([...adapters].filter((entry) => entry.owner === owner).map((entry) => closeAdapter(entry)));
    if (configuredRequests.get(owner) !== request || options.signal?.aborted) return { ok: false, reason: 'aborted' };
    if (!spec) return { ok: false, reason: 'not-configured' };
    const loading = loadVoiceAdapter(spec, { ...options, owner, options: voiceOptions });
    const record = [...adapters].find((entry) => !entry.closed && entry.owner === owner && entry.name === spec);
    if (record) record.signature = signature;
    return loading;
  })();
  try { return await request.work; }
  finally { if (configuredRequests.get(owner) === request) configuredRequests.delete(owner); }
}

/** 已挂载的适配器列表（排查用）。 */
export function attachedAdapters() {
  return [...new Set([...adapters].filter((entry) => entry.ready && !entry.closed).map((entry) => entry.name))];
}

/** 先退订匹配实例，再并行有界等待 detach；不传 owner/scope 时兼容旧的全部卸载。 */
export async function detachAdapters(options = {}) {
  const scoped = Object.hasOwn(options, 'owner') || Object.hasOwn(options, 'scope');
  const owner = adapterOwner(options);
  const targets = [...adapters].filter((entry) => !scoped || entry.owner === owner);
  for (const [key, req] of [...configuredRequests]) {
    if (!scoped || key === owner) {
      configuredRequests.delete(key);
      req.work?.catch(() => {});
    }
  }
  return Promise.all(targets.map((entry) => closeAdapter(entry)));
}
