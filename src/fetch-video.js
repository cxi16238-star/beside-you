/**
 * fetch-video.js — 「链接 → 本地视频」这一段。
 *
 * 现状（改动前）：`see_now` 已经能播本地文件（`source:"file"` + `path`），
 * 抽帧/拼图/seek 全是现成的。缺的只有一步：给一个 URL，先下到本地。
 *
 * 所以这个模块**只做下载**，别的什么都不碰：
 *   - `fetchVideo({ url, quality, cacheDir, signal, log })` 是唯一入口；
 *   - 下载成功后把本地 path 交回去，由 index.js 接进现有 file 分支，
 *     之后的抽帧、拼图、分档、seek 全沿用 —— 一行不改；
 *   - 失败一律返回 `{ ok:false, code, message }`，**不抛异常、不卡住**，
 *     `code` 只有四种：`no-ytdlp` / `download_failed` / `timeout` / `too_large`。
 *
 * yt-dlp 必须存在，查找顺序（见 `resolveYtDlp`）：
 *   1. binaries.js 已登记的外部工具目录（照抄它的结构）
 *   2. PATH
 *   3. 插件自己的 `bin/yt-dlp(.exe)`
 * 找不到就报 `no-ytdlp`，**不静默失败、不自动下载安装**。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFfmpeg } from './binaries.js';

/** 单次下载的超时（毫秒）。到了就杀进程、清半成品、返回 `timeout`。 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 「探名字」那一步的超时：只拿 `<extractor>_<id>`，不用等整段下完。 */
export const PROBE_TIMEOUT_MS = 45_000;
/**
 * 单个文件上限。设成和缓存总预算（2 GB）一样：
 * 一个文件就吃掉整个预算，缓存清理会永远清不动它 —— 这种八成是误抓了整场直播/合集。
 */
export const MAX_FILE_BYTES = 2 * 1024 ** 3;
/** `<cacheDir>/video/` 的总量上限：超过就开始删最旧的。 */
export const VIDEO_CACHE_MAX_BYTES = 2 * 1024 ** 3;
/** 清理后要落到的水位（比上限低，避免每次下载都触发一次清理）。 */
export const VIDEO_CACHE_TARGET_BYTES = 1.5 * 1024 ** 3;

/** 缓存目录里留给 yt-dlp 原始 stderr 的日志文件名（不参与总量统计）。 */
const STDERR_LOG_NAME = 'ytdlp-last-error.log';

/**
 * 清晰度 → yt-dlp 的 `-f` 表达式。**只影响下载哪一档**：
 * 本地文件永远读原片，没有任何重新编码。
 * 默认 `medium`（720p 封顶）：1080p+ 在很多站点要登录，默认档不该一上来就撞登录墙。
 *
 * 为什么不是任务书上的 `worst[ext=mp4]/worst`：B 站是 DASH-only（画面和声音是两条流，
 * 没有现成的单文件 mp4），`worst[ext=mp4]` 一个都匹配不到，直接 "Requested format is
 * not available"（实跑验证过）。改用 `视频+音频` 选择器让 yt-dlp 用 ffmpeg 合成，
 * 直链 mp4 这类单文件站点走最后的 `b` 兜底，行为不变。
 * （任务书注明"可按 yt-dlp 版本微调"，这就是微调。）
 */
export const FORMAT_EXPRS = {
  low: 'wv*+wa/w',
  medium: 'bv*[height<=720]+ba/b[height<=720]/b',
  high: 'bv*+ba/b',
};

const fail = (code, message) => ({ ok: false, code, message });

/**
 * 找 yt-dlp。三处按顺序：
 *   1. 环境变量 `DSH_YTDLP_PATH` / `YTDLP_PATH`（显式指定，最高优先）；
 *   2. binaries.js 里已登记的外部工具目录（`$DSH_HOME/tools/yt-dlp/{bin/,}`、`$DSH_HOME/bin`）；
 *   3. PATH 里逐个目录找（自己扫，不裸 spawn —— 裸 spawn 找不到时会伪装成 download_failed）；
 *   4. 插件自己的 `bin/yt-dlp(.exe)`。
 *
 * @param {{env?:NodeJS.ProcessEnv, platform?:NodeJS.Platform}} [opts]
 * @returns {{path:string, source:string}|null} null = 真没装
 */
export function resolveYtDlp({ env = process.env, platform = process.platform } = {}) {
  const name = `yt-dlp${platform === 'win32' ? '.exe' : ''}`;
  const explicit = env.DSH_YTDLP_PATH || env.YTDLP_PATH || '';
  if (explicit) return { path: explicit, source: 'env' };

  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  const dirs = [
    join(home, 'tools', 'yt-dlp', 'bin'),
    join(home, 'tools', 'yt-dlp'),
    join(home, 'bin'),
  ];
  for (const dir of dirs) {
    const p = join(dir, name);
    if (existsSync(p)) return { path: p, source: p };
  }

  const pathDirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const p = join(dir, name);
    if (existsSync(p)) return { path: p, source: 'PATH' };
  }

  try {
    const bundled = fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
    if (existsSync(bundled)) return { path: bundled, source: 'bundled' };
  } catch { /* 路径拼不出来就当没有 */ }
  return null;
}

/** 把 yt-dlp 报出来的 extractor / id 洗成安全文件名。拿不到 id 就退回 sha1(url) 前 12 位。 */
function videoName(extractor, id, url) {
  const clean = (s) => String(s ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  const ext = clean(extractor).toLowerCase();
  const vid = clean(id);
  const name = ext && vid ? `${ext}_${vid}` : vid;
  return name || createHash('sha1').update(url).digest('hex').slice(0, 12);
}

/**
 * 在缓存目录里找 `<name>.<任意扩展名>` 的成品文件（复用判断 + 下载完成后定位都用它）。
 * 扩展名由 yt-dlp 的 `%(ext)s` 决定（mp4 / webm 都可能），所以只能按前缀找。
 * @returns {{path:string, size:number, ext:string}|null}
 */
function findVideoFile(dir, name) {
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  const prefix = `${name}.`;
  let best = null;
  for (const e of entries) {
    if (!e.startsWith(prefix) || e === `${name}.part`) continue;
    let st;
    try { st = statSync(join(dir, e)); } catch { continue; }
    if (!st.isFile() || st.size <= 0) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: join(dir, e), size: st.size, ext: extname(e).slice(1).toLowerCase() };
  }
  return best;
}

/** 下载失败/超时后清掉半成品 —— 半成品 size>0，不删会被下次当成"缓存命中"。 */
function removePartial(dir, name) {
  try {
    for (const e of readdirSync(dir)) {
      if (e.startsWith(`${name}.`)) {
        try { unlinkSync(join(dir, e)); } catch { /* 删不掉就算了 */ }
      }
    }
  } catch { /* 目录可能还没建出来 */ }
}

/**
 * 原始 stderr 的归宿：写进缓存目录里的一份日志文件 + 插件日志里一行提示。
 * **不能把 stderr 原样丢给模型**：又长又像报错，模型会以为是它自己哪里坏了。
 */
function noteStderr(kind, stderr, dir, log) {
  try {
    writeFileSync(
      join(dir, STDERR_LOG_NAME),
      `${new Date().toISOString()} [${kind}]\n${String(stderr ?? '').slice(-8192)}\n`,
      'utf8',
    );
  } catch { /* 记不住就算了 */ }
  try { log?.(`[fetch-video] ${kind} 失败，yt-dlp 原始报错已写进 ${join(dir, STDERR_LOG_NAME)}`); } catch { /* 同上 */ }
}

/**
 * 第一步：只探 `<extractor_key>\t<id>`，不下任何内容。
 * 拿不到名字 = 这个链接 yt-dlp 认不出来，后面整段都不用跑了。
 */
function runProbe(yt, url, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } };
    const child = spawn(yt, [
      '--print', '%(extractor_key)s\t%(id)s',
      '--no-playlist', '--socket-timeout', '30', '--no-warnings',
      url,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let tail = '';
    const timer = setTimeout(() => { child.kill(); settle({ ok: false, stderr: `probe timeout after ${PROBE_TIMEOUT_MS}ms` }); }, PROBE_TIMEOUT_MS);
    const onAbort = () => { child.kill(); settle({ ok: false, aborted: true }); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { tail = (tail + c.toString('utf8')).slice(-8192); });
    child.on('error', (e) => settle({ ok: false, stderr: `${tail}\n${e?.message ?? e}` }));
    child.on('close', (code) => {
      if (code !== 0) { settle({ ok: false, stderr: tail }); return; }
      const line = out.trim().split(/\r?\n/).pop() ?? '';
      const [extractor = '', id = ''] = line.split('\t');
      settle({ ok: true, extractor, id });
    });
  });
}

/**
 * 第二步：真下载。超时（120 秒）杀进程；下载中每 1.5 秒看一次文件大小，超 2 GB 也杀。
 * 不转发进度、没有进度条 —— 只要最终结果。
 * `ffmpegDir`：DASH 合成要用 ffmpeg；宿主把 ffmpeg 装在 `~/.dsh/tools/ffmpeg/bin`（不进 PATH），
 * yt-dlp 自己找不到，必须用 `--ffmpeg-location` 指过去。
 */
function runDownload(yt, url, fmt, outTpl, dir, name, signal, ffmpegDir) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } };
    const child = spawn(yt, [
      '-f', fmt,
      '-o', outTpl,
      ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
      '--no-playlist', '--socket-timeout', '30', '--no-warnings',
      url,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, code: 'timeout', stderr: tail, message: `下载超时（${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} 秒）。网络慢或视频太大，稍后再试，或者用 quality:"low" 下最小一档。` });
    }, DOWNLOAD_TIMEOUT_MS);
    const sizePoll = setInterval(() => {
      const f = findVideoFile(dir, name);
      if (f && f.size > MAX_FILE_BYTES) {
        child.kill();
        settle({ ok: false, code: 'too_large', stderr: tail, message: '单个文件超过 2 GB 上限，已经停掉并清掉半成品。换 quality:"low" 再试。' });
      }
    }, 1500);
    const onAbort = () => {
      child.kill();
      settle({ ok: false, code: 'timeout', stderr: tail, message: '下载被取消了。' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearInterval(sizePoll); signal?.removeEventListener('abort', onAbort); };
    child.stderr.on('data', (c) => { tail = (tail + c.toString('utf8')).slice(-8192); });
    child.on('error', (e) => settle({ ok: false, code: 'download_failed', stderr: `${tail}\n${e?.message ?? e}` }));
    child.on('close', (code) => {
      if (code === 0) settle({ ok: true });
      else settle({ ok: false, code: 'download_failed', stderr: tail });
    });
  });
}

/**
 * 缓存总量清理：`<cacheDir>/video/` 超过 2 GB 时，按 mtime 从旧到新删，直到 1.5 GB 以下。
 * 只在**成功下载之后**调一次（fetchVideo 保证），启动时不做任何清理（别拖慢冷启动）。
 * 不删日志文件；删不掉的文件跳过（下次再试）。
 *
 * @param {string} cacheDir
 * @param {{maxBytes?:number, targetBytes?:number}} [opts] 阈值可覆盖（测试用）
 * @returns {{ok:boolean, before:number, after:number, removed:number}}
 */
export function trimVideoCache(cacheDir, { maxBytes = VIDEO_CACHE_MAX_BYTES, targetBytes = VIDEO_CACHE_TARGET_BYTES } = {}) {
  const dir = join(cacheDir, 'video');
  let entries;
  try { entries = readdirSync(dir); } catch { return { ok: true, before: 0, after: 0, removed: 0 }; }
  const files = [];
  for (const e of entries) {
    if (e === STDERR_LOG_NAME) continue;
    const p = join(dir, e);
    try {
      const st = statSync(p);
      if (st.isFile() && st.size > 0) files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* 读不到就不计入 */ }
  }
  const before = files.reduce((s, f) => s + f.size, 0);
  if (before <= maxBytes) return { ok: true, before, after: before, removed: 0 };
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = before;
  let removed = 0;
  for (const f of files) {
    if (total <= targetBytes) break;
    try { unlinkSync(f.path); total -= f.size; removed += 1; } catch { /* 删不掉就跳过，下一个 */ }
  }
  return { ok: true, before, after: total, removed };
}

/**
 * 入口。下载（或复用）一个视频页链接，返回本地文件路径。
 *
 * @param {{url:string, quality?:string, cacheDir:string, signal?:AbortSignal|null, log?:Function|null}} opts
 * @returns {Promise<{ok:true, path:string, bytes:number, ext:string, fromCache:boolean}
 *          |{ok:false, code:'no-ytdlp'|'download_failed'|'timeout'|'too_large', message:string}>}
 */
export async function fetchVideo({ url, quality, cacheDir, signal = null, log = null } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    return fail('download_failed', '没给有效的视频链接。');
  }
  let parsed;
  try { parsed = new URL(url.trim()); } catch {
    return fail('download_failed', '链接格式不对 —— 要 http(s) 开头的完整地址。');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return fail('download_failed', '只支持 http(s) 链接。');
  }

  const ytdlp = resolveYtDlp();
  if (!ytdlp) {
    return fail('no-ytdlp', '没装 yt-dlp，先装它再试：winget install yt-dlp.yt-dlp');
  }

  const dir = join(cacheDir, 'video');
  try { mkdirSync(dir, { recursive: true }); } catch (e) {
    return fail('download_failed', `建缓存目录失败：${e?.message ?? e}`);
  }

  // 1) 探出 <extractor>_<id>：拿不到名字就下不了（搜索页/播放列表/要登录的页面都过不了这关）
  const probe = await runProbe(ytdlp.path, url.trim(), signal);
  if (signal?.aborted) return fail('timeout', '下载被取消了。');
  if (!probe.ok) {
    noteStderr('probe', probe.stderr, dir, log);
    return fail('download_failed', '这个链接下不了（yt-dlp 没认出可下载的视频）。'
      + '链接要直接指向视频页 —— 搜索页、播放列表、要登录才能看的页面都不行。');
  }
  const name = videoName(probe.extractor, probe.id, url.trim());

  // 2) 缓存复用：成品文件已经在了就直接交，不再下载（mtime 也不会动）
  const hit = findVideoFile(dir, name);
  if (hit) {
    return { ok: true, path: hit.path, bytes: hit.size, ext: hit.ext, fromCache: true };
  }

  // 3) 下载。`%(ext)s` 让扩展名跟着真实容器走（mp4 / webm 都可能），不要猜。
  const fmt = FORMAT_EXPRS[String(quality ?? '').toLowerCase()] ?? FORMAT_EXPRS.medium;
  const ff = resolveFfmpeg();
  // 裸 'ffmpeg'（靠 PATH）时不用指路，yt-dlp 自己能找到；宿主那份才需要显式指过去
  const ffmpegDir = ff && ff.source !== 'PATH' ? dirname(ff.path) : null;
  const r = await runDownload(ytdlp.path, url.trim(), fmt, join(dir, `${name}.%(ext)s`), dir, name, signal, ffmpegDir);
  if (!r.ok) {
    removePartial(dir, name);
    if (r.code === 'timeout' || r.code === 'too_large') return fail(r.code, r.message);
    noteStderr('download', r.stderr, dir, log);
    return fail('download_failed', '下载失败（可能是链接过期、要登录、地区限制或网络问题）。'
      + '原始报错已写进插件日志，没丢给你。');
  }

  const got = findVideoFile(dir, name);
  if (!got) {
    noteStderr('post', 'yt-dlp 退出码 0 但缓存目录里没有成品文件', dir, log);
    return fail('download_failed', '下载完成了但文件没落到缓存里，原因已写进插件日志。');
  }

  // 4) 缓存总量清理：只在**真的下载过**之后检查一次（缓存命中不触发）
  const trim = trimVideoCache(cacheDir);
  if (trim.removed > 0) {
    try {
      log?.(`[fetch-video] 视频缓存超限：${(trim.before / 1024 ** 3).toFixed(2)} GB → ${(trim.after / 1024 ** 3).toFixed(2)} GB（删了 ${trim.removed} 个最旧的）`);
    } catch { /* 日志写不进不影响交付 */ }
  }

  return { ok: true, path: got.path, bytes: got.size, ext: got.ext, fromCache: false };
}
