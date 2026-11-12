/**
 * index.js — 插件入口。只做三件事：注册工具、路由 action、把图交成附件。
 *
 * **唯一的取图方式是 `watch`**：它阻塞到「攒够一张」或超时，然后把图作为**工具返回值**
 * 交给宿主。不要用 `sessionController.prompt` 往会话里推 —— 那样模型看到图又去调工具、
 * 自己唤醒自己，停不下来（0.0.1 就是死在这儿）。
 */

import { createRunner, SCENE_OPTS, PACES, DEFAULT_PACE } from './runner.js';
import { resolveFfmpeg } from './binaries.js';
import { parseRegion } from './layout.js';
import { seeNowToolSpec, TOOL_TIMEOUT_MS, DEFAULT_BLOCK_SEC, TOOL_NAME } from './tool-spec.js';
import { SEE_NOW_HELP } from './help.js';
import { interjectNote, replyReminder, clearInterjected, noteInterjected } from './interject.js';
import { appendSpoken, appendChat, lastSaidNote, lastSaidText, chatDir, chatWatcherShared, chatWaiterCount, muteNote, windowControl } from './chat.js';
import { ensureConfiguredVoice, detachAdapters, attachedAdapters, configuredVoiceAdapter, lastVoiceError } from './voice.js';
import { speechSubscribers, onSpeech } from './speech.js';
import { markSpeaking } from './listen.js';
import { startLoop, HANGUP_NOTE } from './loop.js';
import { readTuning, tuningPath, writeTuning, TIER_STYLES } from './tuning.js';
// 快捷键/焦点那套伴生进程 + 组合键的显示文本（"Ctrl+Alt+K" 只出现在日志和状态里）
import { createCompanion } from './companion.js';
import { hotkeyText } from './hotkeys.js';
// `wakeSession` 是小窗说话那条桥唯一该用的叫醒方式：它不抛、不排队、失败有日志
import { wakeSession } from './timer.js';
import { planOffload, planOffloadWithTrigger, applyOffload } from './offload.js';
import { fetchVideo } from './fetch-video.js';
import { defineToolCompat } from './define-tool.js';
import { createSettingsApi, ROUTE_PREFIX } from './settings-api.mjs';
import { windowAlive, windowHidden, setWindowHidden, hiddenForShow, windowReport, windowLine,
  setWindowDanmaku, readWindowDanmaku, openWindow, setWindowStatus, setWindowHotkeys,
  readWindowFocusLock, setWindowFocusLock,
  rememberWindowSwitches, rememberedWindowSwitches } from './window.js';
import { pickRegion, loadRegion, saveRegion, clearRegion, regionText } from './region.js';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, watchFile, unwatchFile, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** ESM 里拿到同步 require（`node:sqlite` 只有同步 API，动态 import 是异步的）。 */
const nodeRequire = createRequire(import.meta.url);

/**
 * 从工具参数构造 source 描述。`watch` 和 `start` 两个入口共用。
 *
 * `region` 是 `source:"screen"` 的**修饰参数**，不是独立 kind：
 *   - 它同时把 engine 钉死在 `gdigrab` —— `ddagrab` 是 filter source，没有
 *     `-offset_x`/`-video_size`，带 region 给它会把偏移**静默丢掉**（抓到整屏，
 *     用户和模型都以为生效了，这是最坏的一种失败）；
 *   - 格式不对时**明确返回错误**，同样不静默退化成全屏。
 *
 * @returns {{src: object|null, error?: string}}
 */
function srcOf(args) {
  /**
   * 只给 `path` 不给 `source` 时按**文件回放**算。
   *
   * 以前这里是 `args.source ? … : null`，于是 `see_now({action:"start", path:"x.mp4"})`
   * 会静默退化成 `{kind:'screen'}` —— 用户以为在看那个视频，其实在抓整屏，
   * 而且没有任何报错。这类"看起来成功了、其实做的是另一件事"是最坏的失败。
   */
  const kind = args.source ? String(args.source).toLowerCase() : (args.path ? 'file' : null);
  // `source:"portal"` 是 Linux 采集的调试别名（不写进工具说明，省常驻 token）：
  // 语义和 `source:"screen"` 完全一样，只是把引擎钉死在 portal、不再自动探测。
  if (kind === 'portal') return { src: { kind: 'screen', engine: 'portal' } };
  const src = kind ? { kind } : null;
  if (src && kind === 'file') {
    src.path = args.path;
    src.realtime = args.realtime === true;
  }
  const rawRegion = args.region;
  if (rawRegion === undefined || rawRegion === null || rawRegion === '') return { src };
  if (src && kind !== 'screen') {
    return { src: null, error: `region 只能配 source:"screen"，现在是 "${kind}"。` };
  }
  const region = parseRegion(rawRegion);
  if (!region) {
    return {
      src: null,
      error: `region 格式不对：「${String(rawRegion)}」。要 "x,y,w,h" 四个整数（屏幕物理像素，`
        + '和 desktop_control 的 window rect 同一套坐标），例如 "1593,375,568,1010"。'
        + '\n没有按全屏抓 —— 那会让你以为 region 生效了。',
    };
  }
  const out = src ?? { kind: 'screen' };
  out.region = region;
  /**
   * Linux：portal 交出来的是整块屏幕的流，**region 坐标就用这条流的坐标系**
   * （KDE 上是逻辑像素，例如 2048×1280；`status` 会报当前流的尺寸）。
   * 裁切由 worker 按 portal 报的 size 做 `videocrop`，越界会明确报错。
   *
   * 不钉 `engine: 'gdigrab'` —— 那是 Windows 的抓屏引擎，Linux 上要让 runner
   * 继续走 portal。
   */
  if (process.platform !== 'linux') out.engine = 'gdigrab';
  return { src: out };
}

export const name = 'beside-you';

/**
 * `watch` 最多阻塞多久。
 *
 * **必须比宿主的 timeoutMs 早收工**：工具自己挂得比宿主的死线还久，到点就不是
 * "返回一张图"，而是整条调用被 abort（`signal` 一起 abort，模型看到的是超时错误）。
 * 留 40 秒给建图/交附件/模型想一想。
 */
const MAX_BLOCK_SEC = Math.max(30, Math.floor(TOOL_TIMEOUT_MS / 1000) - 40);

/** 版本号：从 package.json 读，只为日志里能分清"跑的是哪一版"。读不到就 `?`。 */
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; }
})();

// 三个都在 inject 里声明：cordis 的属性访问只沿 fiber 父链找**已注册**的服务，
// 不声明时 `ctx.attachments` 是 undefined，而且 `?.` 挡不住（get 陷阱直接 throw）。
export const inject = ['tools', 'attachments', 'sessionController'];

/**
 * 「刚交出去图」的回调。`attachAndReturn` 是模块级函数，够不到 apply 作用域里的
 * `tuning` / `lastSessionId`，所以走这条钩子：apply 时挂上，交付后触发自动省略。
 * 用钩子而不是把 `attachAndReturn` 改成闭包 —— 它被测试和其他分支到处调用。
 */
let afterDelivery = null;

/** 可选服务：优先 `ctx.get()`，老宿主退回属性访问且包 try。 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx?.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 没声明 inject 时 get 陷阱会 throw */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

/**
 * 设置页那个"绑哪个会话"的下拉框要的选项。
 *
 * 形状是宿主的 `SessionListEntry`（`@deepseek-ai/dsh-api-session-controller` 的
 * `summaryFor()`）：`{ sessionId, updatedAt, running, blank, ...listFields(header), projections? }`。
 * 三个容易踩的点，都是对着宿主源码核过的：
 *   - **id 叫 `sessionId`**，`listFields(header)` 只回 `parentSessionId/origin/cwd`，
 *     header 里根本没有 id。
 *   - 标题也不在 header 里，在 `projections.values.title`（"最近一条 `session/title`
 *     事件的正文"，还没起标题时是 `null`）。照 header 找标题会全军覆没，只剩 id 前缀。
 *   - `list()` **自己不过滤归档**：归档的会话照样躺在返回里。不管的话下拉里大半是
 *     用户早就收起来的东西，要找的那个反而被淹了。归档的唯一权威是
 *     `workspaceRegistry.archivedSessionIds`。
 *
 * 另外把"当前会话"标出来（`active`），设置页会给它加一个「（当前）」后缀 —— 不标的话
 * 用户没法确认"跟随当前会话"此刻到底跟着谁。
 *
 * `sessions.list()` 那条路留着当兜底：`sessionController` 万一没挂上，内存库里还有
 * 原始会话对象（形状不一样，下面的取值全靠 `??` 一路退化）。
 *
 * @returns {Promise<Array<{id:string,title:string,at:number|null,active:boolean}>>}
 */
async function listSessionsForSettings(ctx, currentId = null) {
  const raw = [];
  const sc = serviceOf(ctx, 'sessionController');
  if (typeof sc?.list === 'function') {
    try {
      const value = await sc.list({}, undefined);
      // `@Remote` 方法可能回 `{items:[...]}` / `{sessions:[...]}` / 直接数组
      const list = Array.isArray(value) ? value
        : Array.isArray(value?.sessions) ? value.sessions
          : Array.isArray(value?.items) ? value.items : [];
      raw.push(...list);
    } catch { /* 这一条路不通还有下一条 */ }
  }
  if (raw.length === 0) {
    const store = serviceOf(ctx, 'sessions');
    if (typeof store?.list === 'function') {
      try {
        const list = store.list();
        if (Array.isArray(list)) raw.push(...list);
      } catch { /* 拿不到就当没有 */ }
    }
  }

  // 归档名单：`archivedSessionIds` 是个 getter（每次读都现算），读不到就当没有。
  const archived = new Set();
  for (const key of ['workspaceRegistry', 'workspace']) {
    let ids = null;
    try { ids = serviceOf(ctx, key)?.archivedSessionIds; } catch { ids = null; }
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === 'string' && id) archived.add(id);
    if (archived.size > 0) break;
  }

  // 所有工作区的会话都要能选 —— 用户原话：「工作区所有的会话都可以选，不是只能选默认工作区」。
  // （早先按当前会话的 cwd 筛过一轮，那是为了压长度；实测把别的工作区整个筛掉了，
  //   绑不上正在看的那个会话，比列表长更糟。长度交给下面的截断 + 设置页的搜索框。）
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = item?.sessionId ?? item?.header?.id ?? item?.session?.header?.id ?? item?.id;
    if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
    if (archived.has(id)) continue;
    // 空白会话（还没说过一句话）没有标题、绑上也没意义 —— 但**当前**那个除外：
    // 用户刚开的新会话就是空白，把它藏了，"跟随当前会话"跟着谁就又看不出来了。
    if (item?.blank === true && id !== currentId) continue;
    seen.add(id);
    const title = item?.projections?.values?.title
      ?? item?.header?.title ?? item?.title ?? item?.header?.name ?? item?.name
      ?? item?.header?.summary ?? item?.summary ?? '';
    const at = Number(item?.updatedAt ?? item?.header?.updatedAt ?? item?.header?.createdAt ?? item?.createdAt);
    out.push({
      id,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : '',
      at: Number.isFinite(at) && at > 0 ? at : null,
      active: id === currentId,
    });
  }
  // 新的排前面：用户要找的多半是刚开的那个。
  // 上限放到 120：现在不按 cwd 筛了，几个工作区加起来可能上百条；设置页那个下拉
  // 带搜索框，长不是问题，**漏**才是问题 —— 要绑的那个偏偏排在第 51 位最气人。
  out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return out.slice(0, 120);
}

/**
 * 把返回值洗成**无损 JSON**。宿主会校验 `JSON.parse(JSON.stringify(v))` 与原值等价，
 * 只要对象里有 `undefined`（哪怕只是某个可选字段没赋值）就判
 * `tool returned invalid output: value is not lossless JSON`，整条调用作废。
 */function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toLosslessJson(v);
  return out;
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch { /* 落到环境变量 —— 本地开发/测试时用 */ }
  /**
   * 第二跳：`DSH_TOOLS_PATH` 指向磁盘上的那份（本地开发时用）。
   * **包一层 try**：路径写错不该让插件整个废掉。
   */
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(override).href);
      if (mod?.defineTool) return mod.defineTool;
    } catch { /* 路径不对，继续落到兜底 */ }
  }
  /**
   * 最后一跳：内置兼容实现。**不能再抛** ——
   * 宿主的包在 `app.asar` 里，插件侧经常解析不到（社区实报），
   * 抛出去会被 apply 的 catch 吞掉，结果是**整个插件静默不注册任何工具**。
   * 内置版只少了运行时参数校验，工具照常能用（详见 define-tool.js）。
   */
  return defineToolCompat;
}

/**
 * 台词清单。**只在真有台词时出现** —— 转写没开/没听见的时候，凭空来一行
 * "台词："只会让模型以为转写坏了，然后去猜。
 *
 * 两个时间都给：
 *  - **本机时钟**（`15:57:32`）：用户回头找"那句话是什么时候说的"只能靠它 ——
 *    实时看屏幕没有"视频进度"这个东西，浏览器放第几秒我们根本不知道；
 *  - **相对秒**（`9.3s`）：和上面每帧那个 `24.1s` 是同一个坐标系，模型才能把
 *    "这句话"对到"第几格画面"。
 */
/**
 * DSH 认证 cookie 的"拥挤度"（实际还活着的条数）。
 *
 * 宿主每次登录都会在 127.0.0.1 上签一个 **新的** `dsh-auth-<随机串>` cookie，旧的从不清理。
 * 攒到 70 条左右，`Cookie` 头就超过 16KB，**下次启动在认证那一步直接挂**
 * （`desktop welcome: Web authentication failed`，`phase: startup`）——
 * 那时候任何插件都跑不起来，也就没法自救。所以只能趁还能跑的时候提醒。
 *
 * 用宿主内置的 `node:sqlite` 精确数。**不用"扫文件里的字符串"**：sqlite 删行不擦页，
 * 清理完之后残留还在——实测清到 1 条，按字符串数能数出 95 条，纯误报。
 *
 * @param {string|null} file 覆盖路径（测试用）
 * @returns {number|null} 条数；读不到（mac / 没装 / 没权限 / 没有 sqlite）返回 null
 */
export function authCookiePressure(file = null) {
  try {
    const p = file || join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies');
    // 动态 require：`node:sqlite` 在某些 Node 版本里还是 experimental，
    // 静态 import 会在没有它的运行时直接让整个插件加载失败 —— 一个体检功能不值这个。
    const { DatabaseSync } = nodeRequire('node:sqlite');
    const db = new DatabaseSync(p, { readOnly: true });
    try {
      const row = db.prepare("select count(*) as c from cookies where name like 'dsh-auth-%'").get();
      return Number(row?.c ?? 0);
    } finally { db.close(); }
  } catch { return null; }
}

/**
 * 台词清单。**只在真有台词时出现** —— 转写没开/没听见的时候，凭空来一行
 * "台词："只会让模型以为转写坏了，然后去猜。
 *
 * 三个信息叠在一行：
 *  - **`#2`**：这句话最接近第几格画面。模型不用自己拿时间码去对格子，
 *    一眼就知道"这句配那张图"；
 *  - **本机时钟**（`15:57:32`）：用户回头找"那句话是几点说的"只能靠它 ——
 *    实时看屏幕没有"视频进度"这个东西，浏览器放到第几秒我们根本不知道；
 *  - **相对秒**（`9.3s`）：和每帧那个 `24.1s` 同一坐标系，可交叉验证。
 */
export function linesText(sheet) {
  const got = sheet.lines;
  if (!got?.length) return '';
  const frames = sheet.frames ?? [];
  const f0 = frames[0];
  // frame.wall 是 epoch ms、frame.t 是相对秒 → 两者相减就是"t=0 那一刻的 epoch"
  const origin = f0?.wall != null ? f0.wall - f0.t * 1000 : null;

  /** 这句话落在哪一格：最后一个 `t <= 本句起点` 的帧（比首帧还早的归第 1 格）。 */
  const cellFor = (tRel) => {
    if (!frames.length) return null;
    let idx = 0;
    for (let i = 0; i < frames.length; i += 1) if (frames[i].t <= tRel + 1e-6) idx = i;
    return idx + 1;
  };

  const rows = got.map((l) => {
    const tRel = origin === null ? null : (l.t0 - origin) / 1000;
    const rel = tRel === null ? null : `${tRel.toFixed(1)}s`;
    let clock = null;
    try { clock = new Date(l.t0).toLocaleTimeString('zh-CN', { hour12: false }); } catch { /* 时区数据缺失 */ }
    const stamp = [clock, rel].filter(Boolean).join(' / ');
    const cell = tRel === null ? null : cellFor(tRel);
    // `partial` = 长句说到一半先给的临时版（还没断句）。标出来，模型才不会当成定论。
    const tail = l.partial ? '（还在说…）' : '';
    return `  ${cell === null ? '' : `#${cell}  `}${stamp || '—'}  ${l.text}${tail}`;
  });
  return `\n台词（这段时间里视频里在说的，机器转写，可能有错字/听岔；`
    + '`#n` = 这句最接近第 n 格画面，后面是本机时钟 / 相对这张图起点的秒数；'
    + '带「还在说…」的是说了一半的临时版）：\n'
    + rows.join('\n');
}

/**
 * 循环状态那一行。三种态要分清，别都写成"在跑"：
 *   - `listen`：采集停了，但窗口里的输入还收得到（用户打字仍然能叫醒模型）
 *   - `active`：正常在跑
 *   - 已停 / 没起
 *
 * **必须在模块顶层**：它原来写在 `route()` 里面（靠函数提升才没报错），
 * 于是每次工具调用都要重新创建三个闭包，而且缩进是 0 —— 读代码的人会以为它在外面。
 */
/**
 * 一行档位分布。`hist` = `{1: 3, 3: 12}`。
 *
 * 为什么要有：用户看到"格子变了"时，原因可能是**节奏**（帧变稀 → 密度档位变小）、
 * **映射**（strategy/tierMap）、或者**锁定**。三者都改尺寸，只报节奏那一行分不出来。
 */
function tierLine(hist, src) {
  const entries = Object.entries(hist ?? {}).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return '';
  const total = entries.reduce((sum, [, n]) => sum + Number(n), 0);
  const parts = entries
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, n]) => `${k}档×${n}`);
  /**
   * 尺寸有**四个来源**：判据（密度/变化）→ 密度 → 阈值表 → 映射。只报最后一个，
   * 用户看到格子变了却查不出是哪一层 —— 所以非默认的都跟一句，默认的不占地方。
   */
  const bits = [src?.style ?? 'native'];
  if (src?.mode && src.mode !== 'density') bits.push(`判据 ${src.mode}`);
  if (src?.curve && src.curve !== 'docx') bits.push(`阈值 ${src.curve}`);
  return `\n档位：${bits.join(' · ')}（${parts.join(' ')}，共 ${total} 帧）`;
}

function loopLine(lp) {
  if (!lp) return '没起（还没调过 watch）';
  if (lp.mode === 'listen') return '只听（采集已停，窗口里的输入还收得到；要看就调 peek）';
  if (lp.stopped) return lp.reason ? `已停（${lp.reason}）` : '已停';
  const fail = lp.wakeFailures ? `，失败 ${lp.wakeFailures} 次` : '';
  const last = lp.lastWakeAt
    ? `，上一次 ${Math.round((Date.now() - lp.lastWakeAt) / 1000)}s 前${lp.lastWakeOk === false ? '（失败）' : ''}`
    : '';
  // 节奏诊断：上一句多长、下一轮最早什么时候 —— 用户问"怎么半天不说话"时先看这两个数
  const speech = lp.lastSpeechMs ? `，上一句约 ${(lp.lastSpeechMs / 1000).toFixed(1)}s` : '';
  const wait = lp.nextWakeAt && lp.nextWakeAt > Date.now()
    ? `，下一轮最早 ${Math.ceil((lp.nextWakeAt - Date.now()) / 1000)}s 后` : '';
  return `在跑（叫醒 ${lp.wakes} 次${fail}${last}${speech}${wait}，会话 ${lp.session ?? '未知'}）`;
}

/** 快到临界才提醒 —— 超了之后插件根本跑不起来，只能趁现在说。 */
function cookieWarnLine() {
  const n = authCookiePressure();
  if (n === null || n < 50) return '';
  return `\n⚠ DSH 认证 cookie 已约 ${n} 条：攒到 70 条左右宿主会起不来`
    + '（`Web authentication failed`，跟插件无关）。关掉 DSH 后跑 `tools/fix-dsh-startup.cmd` 清一下。';
}

/**
 * 「听声音」一行。
 *
 * 用户说"它好像没听见台词"时，答案全在这一行：是没转写服务、没 Python 包、
 * 还是这台机器根本抓不到回环。**不要把未启用写成"正常"** —— 那会让人一直查画面。
 */
function listenLine(l) {
  if (!l) return '没起（还没调过 watch）';
  if (!l.enabled) return `没在听 —— ${l.reason}`;
  // **转写挂了不能说成"在听"**：那会让人一直去查画面。
  // 2026-11-04 社区实报：本地 ASR 服务没起，界面上一直显示"在听、0 句"，
  // 看起来和"视频是默片"一模一样。
  if (l.paused) return `在听但转写停了：${l.error ?? '原因未知'}（30 秒后自动重试，音量条还在）`;
  if (l.error) return `在听（${l.backend}），但最近一次转写失败：${l.error}`;
  const last = l.lastSegAt ? `，最近一句 ${Math.round((Date.now() - l.lastSegAt) / 1000)}s 前` : '，还没转出过台词';
  // 延迟诊断：从"这句话开口"到"进了台词缓冲"用了多久。调快慢就看这一个数。
  const lag = l.lastLineLagMs != null ? `，上一句开口→可读 ${(l.lastLineLagMs / 1000).toFixed(1)}s` : '';
  const part = l.partials ? `，临时字幕 ${l.partials} 次` : '';
  return `在听（${l.backend}，累计 ${l.total} 句${last}${lag}${part}）`;
}

/** 变化区域 → 「中右」这种方位词。`box` 是 0..1 的比例（见 pipeline 的 `noteChange`）。 */
function whereText(box) {
  if (!box) return '';
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const h = cx < 0.34 ? '左' : cx > 0.66 ? '右' : '';
  const v = cy < 0.34 ? '上' : cy > 0.66 ? '下' : '';
  if (!h && !v) return '中心';
  return `${v}${h}`;
}

/**
 * 变化日志 → 一段文本。每行是「这期间屏幕变了多少、哪里变」。
 *
 * 它补的正是 `queueDepth: 1` 挤掉的那些画面：模型只看到"现在"的时候，
 * 靠它知道"刚才"。`changeLog` 关着时 `sheet.changes` 不存在，这里什么都不输出。
 */
function changeText(changes) {
  if (!Array.isArray(changes) || !changes.length) return '';
  const rows = changes.map((c) => {
    const what = c.peak < 2 ? '静止' : c.cut ? '⚡切场景' : '变化';
    const pos = whereText(c.box);
    const area = c.box ? Math.round((c.box.x1 - c.box.x0) * (c.box.y1 - c.box.y0) * 100) : 0;
    const at = c.at >= 60 ? `${Math.floor(c.at / 60)}分${Math.round(c.at % 60)}秒` : `${c.at.toFixed(1)}s`;
    return `  ${at} · 分 ${c.peak} · ${what}${pos ? ` · ${pos}` : ''}${area ? ` ${area}%` : ''}`;
  });
  return `\n变化日志（${changes.length} 段；图被挤掉时只有这个）：\n${rows.join('\n')}`;
}

/** 一张图 → 模型看得懂的清单。数字都是「这张图里第几格」，不是抽象指标。 */
function sheetText(sheet, { waited = 0, partial = false, userText = null, say = null, looping = false, order = null } = {}) {
  const { frames, from, to, why } = sheet;
  // 单帧时首尾相等，写成区间会变成"过去 24.1–24.1 秒"，读起来像出错了
  const span = frames.length === 1
    ? `此刻（第 ${frames[0].t.toFixed(1)} 秒）的 1 个画面`
    : `过去 ${from.toFixed(1)}–${to.toFixed(1)} 秒的 ${frames.length} 个画面`;
  const head = (order ? `第 ${order.i}/${order.n} 张 · ` : '') + `${span} · ${sheet.w}×${sheet.h}`
    + `${partial ? '，还没攒满就截断了' : ''}`
    + `${waited ? ` · 等了 ${waited.toFixed(0)}s` : ''}`;
  const lines = frames.map((f, i) => {
    const cell = sheet.cells?.[i];
    const size = cell ? `${cell.pw}×${cell.ph}` : '—';
    // 档位要报**两件事**：算法给的档位，和它实际占多少画布。
    // 两者不一致是因为排布器为了把这一批塞进一张图，把格子压小了 —— 只报档位会让
    // 人以为"1 档 = 整幅"，而实际是 400×225（踩过：用户看到"1 档"配 400×225 以为算错了）。
    const k = cell ? Math.max(1, Math.round(sheet.w / Math.max(1, cell.pw))) : null;
    const tierText = k && k !== f.tier ? `${f.tier}档→1/${k}` : `${f.tier} 档`;
    return `  ${i + 1}. ${f.t.toFixed(1)}s · ${size} · ${f.via} · ${tierText}`;
  });
  const whyText = why === 'user' ? '用户插话截断的'
    : why === 'timeout' ? '等满了先给你'
      : why === 'time' ? '攒到这个点先给你'
        : why === 'full' ? '这张装满了'
          : why === 'first' ? '刚打开，先给你此刻'
            : why === 'oneshot' ? '换了清晰度，先给你此刻'
              : '流结束';
  const ask = userText
    ? `\n${interjectNote(userText, { at: Date.now() })}`
    : '';
  // 常驻模式要**明说**，否则模型会以为"还得我自己再调一次"，或者以为"看一眼就完事了"
  const loopNote = looping
    ? '\n**已经进入常驻模式**：下一张攒够我会再叫你，不用你现在就调下一次。'
      + '不要每个画面都说话：一段剧情里顶多一两句，只在真有东西想说的时候才开口；没意思就一声不吭，沉默是对的。'
      + '用户关掉悬浮窗我就停。'
    : '';
  return `${head}\n${lines.join('\n')}${linesText(sheet)}${changeText(sheet.changes)}${ask}${lastSaidNote()}${muteNote()}${loopNote}\n（${whyText}；想看下一段就再调一次 \`see_now({action:"watch"})\`。）${replyReminder({ answered: Boolean(say) })}`;
}

/**
 * 提交成宿主附件，并组装工具返回值。
 *
 * **`saveImage` 必须 `.call(svc, …)`**：它内部读 `this.compression`，方法取下来裸调会丢 this，
 * 报 `Cannot read properties of undefined (reading 'compression')` —— 所有出图工具一起挂。
 */
/**
 * 把一张**或多张**图交给宿主，拼成一次工具结果。
 *
 * 超省模式（`wakeBatch > 1`）下一次要交好几张 —— 分成几次交就等于没攒：
 * 模型每轮都要把整个上下文重过一遍，省下来的钱全在这条上。
 *
 * `meta` 里单张的字段（`frames` / `from` / `to` / `fill` / `why` / `bytes`）保持不变，
 * 单张时语义完全一样；多张时 `frames` / `bytes` 是合计，`from` / `to` 是首尾，
 * 逐张的区间放进 `sheets[]`。`batch` 说明这次交了几张。
 */
/** 最近一次交付给模型的画面（attachments 引用），暂停通知里附给它。 */
let lastSeenSheet = null;

async function attachAndReturn(ctx, sheets, extra = {}) {
  const svc = serviceOf(ctx, 'attachments');
  const list = (Array.isArray(sheets) ? sheets : [sheets]).filter(Boolean);
  if (!list.length) {
    return { text: '没有可交付的画面。', meta: { ok: false, ...extra, batch: 0 } };
  }
  if (!svc?.saveImage) {
    return { text: '拿到图了，但宿主没有 attachments 服务，交不上去。', meta: { ok: false, ...extra } };
  }
  const refs = [];
  for (const s of list) {
    refs.push(await svc.saveImage.call(svc, {
      data: s.png,
      mediaType: 'image/png',
      name: `see-now-${Date.now()}${list.length > 1 ? `-${refs.length + 1}` : ''}.png`,
    }));
  }
  // 记下最后交付的画面：暂停通知（signalPause）拿它当"最后看到的样子"。
  // 存的是宿主给的引用，不是 base64 —— 消息里直接用 durable 引用，不重复上传。
  if (refs.length) lastSeenSheet = { ref: refs[refs.length - 1] };
  // `say` 是给清单用的，不进 meta —— 那是整段话，塞进 meta 只会让返回值翻倍
  const { say: said, ...meta } = extra;
  // 图已经交给宿主了，顺手看要不要省略老的（异步、不阻塞、失败只记日志）
  try { afterDelivery?.(); } catch { /* 省略绝不能影响这一张图的交付 */ }
  const first = list[0];
  const last = list[list.length - 1];
  return {
    images: refs,
    text: list
      .map((s, i) => sheetText(s, { ...extra, order: list.length > 1 ? { i: i + 1, n: list.length } : null }))
      .join('\n\n'),
    meta: {
      ...meta,
      said: said ? String(said).slice(0, 200) : null,
      batch: list.length,
      sheets: list.map((s) => ({
        from: +s.from.toFixed(2), to: +s.to.toFixed(2), frames: s.frames.length, bytes: s.png.length,
      })),
      frames: list.reduce((n, s) => n + s.frames.length, 0),
      from: +first.from.toFixed(2),
      to: +last.to.toFixed(2),
      fill: +first.fill.toFixed(3),
      why: first.why,
      bytes: list.reduce((n, s) => n + s.png.length, 0),
    },
  };
}

/** 当前声音状态（status 用）。**听不到声音时第一个要看的就是它。** */
function voiceState() {
  const configured = configuredVoiceAdapter();
  let speakers = 0;
  try { speakers = speechSubscribers(); } catch { /* 总线还没建起来 */ }
  return {
    configured: configured ?? null,
    adapters: attachedAdapters(),
    speakers,
    // 配了但没挂上：把最后一次失败原因带出来，否则只能猜"是不是没重启"
    reason: speakers > 0 ? null : (lastVoiceError() ?? null),
  };
}

/**
 * 测试钩子：`attachAndReturn` 是**多图交付**的核心（超省模式一轮交好几张），
 * 但它藏在 `apply` 的闭包里，不导出就只能靠起整个插件去验。
 * 和 `client.js` 的 `__test` 一个路数 —— 只暴露纯函数，不碰宿主状态。
 */
export const __test = { attachAndReturn, sheetText };

export async function apply(ctx) {
  try {
    return await registerAll(ctx);
  } catch (e) {
    // 最坏的情况是插件不能用，不是应用起不来
    try { ctx?.logger?.error?.(`[beside-you] failed to load: ${e?.stack ?? e}`); } catch { /* ignore */ }
    /**
     * **失败必须留痕。** 以前只打 logger.error —— 那玩意儿只在开发者工具里，
     * 用户看到的现象是"这个会话根本没有 see_now 这个工具"，模型只能靠读文件猜，
     * 还把猜出来的调用当正文吐出来（2026-11-03 实报）。
     * 现在写到 `~/.dsh/see-now/plugin-error.log`，出问题直接看这个文件。
     */
    writeLoadError(e);
    if (process.env.DSH_SEE_DEBUG) throw e;
    return () => {};
  }
}

/**
 * 挂设置页的两条路由（`/api/see-now/status` 与 `/api/see-now/config`）。
 *
 * `webServer` **刻意不写进 `inject`**：它是可选能力，写进去会让没有它的部署连
 * 插件都起不来 —— 工具也跟着一起消失。改为 `ctx.inject` 按需拿。
 *
 * 而且它可能比本插件晚挂载，所以必须在这个回调里注册，不能在 apply 时读一次：
 * 读一次会永远拿到 `undefined`，面板就永远不出现，宿主那头却毫无异样。
 *
 * 这里整段包在 try 里：面板是附加能力，挂不上只该少一页设置，不该影响看屏幕。
 */
/**
 * 挂设置页的三条接口。
 *
 * `hooks` 是**回取式**的（函数而不是值）：`/status` 要在打开面板那一刻现取会话列表
 * 和伴生进程状态，而那些东西在这个函数被调用时还没建出来。传值会传进一片 undefined。
 */
function installSettings(ctx, log, hooks = {}) {
  try {
    if (typeof ctx?.inject !== 'function') {
      log('宿主没有 ctx.inject，跳过设置页接口');
      return;
    }
    const handle = createSettingsApi({ logger: ctx?.logger, ...hooks });
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: (req, res) => handle(req, res, readConnection(scoped)),
          }),
        'beside-you: settings routes',
      );
    });
  } catch (e) {
    log(`设置页接口没挂上：${e?.message ?? e}`);
  }
}

/** 每次请求现取 `connection`：它同样晚挂载，缓存会缓存到 undefined。 */
function readConnection(scoped) {
  try {
    return scoped.get('connection');
  } catch {
    return undefined;
  }
}

/** 加载失败落盘（追加，超过 64KB 就重开一份；不抛）。 */
function writeLoadError(e) {
  try {
    const path = join(chatDir(), 'plugin-error.log');
    mkdirSync(dirname(path), { recursive: true });
    let old = '';
    try { old = readFileSync(path, 'utf8'); } catch { /* 第一次 */ }
    if (old.length > 64 * 1024) old = old.slice(-32 * 1024);
    writeFileSync(path, `${old}${new Date().toISOString()} ${e?.stack ?? e}\n`, 'utf8');
  } catch { /* 记不住也不能再炸一次 */ }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const disposers = [];
  const log = (m) => { try { ctx?.logger?.info?.(`[beside-you] ${m}`); } catch { /* ignore */ } };

  // DSH 桌面版把 ffmpeg 放在 `~/.dsh/tools/ffmpeg/bin`，**不进 PATH**。
  // 写裸 'ffmpeg' 在 macOS 上就是 ENOENT，而且会伪装成"插件坏了"。
  const ffmpeg = resolveFfmpeg();
  log(`ffmpeg: ${ffmpeg.path}（${ffmpeg.source}）`);
  /**
   * 用户自己的节奏参数（`~/.dsh/see-now.json`）。在 apply 时读一次：
   * 改配置要重开 DSH，和 voice.json 的热读不同 —— 这些值影响的是循环的收工线，
   * 每拍读盘不值得。
   *
   * **必须在 createRunner 之前读**：`listen` 段要传给听声音那条链
   * （断句参数、pollMs、长句快照都在里面）。
   */
  const tuning = readTuning();
  if (tuning.warnings.length) log?.(`[see-now] ${tuning.warnings.join('；')}`);

  /**
   * 快捷键/焦点那套伴生进程。**在这里先声明**（真正的实例在下面创建）：
   * 设置页的 `/status` 随时可能来问它，而 `const` 的暂时性死区会让那种请求
   * 在"插件刚挂载"的那一瞬间炸出一个 ReferenceError。
   */
  let companion = null;

  /**
   * 用户能在设置页里改、而且**改了立刻生效**的那几项。
   *
   * 其他参数（节奏、档位…）还是"存了盘、下次重开插件才生效"——它们影响的是管线参数，
   * 热改会让正在跑的那一轮前后不一致。这四项不一样：它们是"开关"，用户按下去
   * 期待的是当场有反应，而不是"重启 DSH 再说"。
   *
   * **声明在这里而不是 `ensureLoop` 旁边**：`mirrorAssistantText`（下面 event 回调里）
   * 要读它，而那段回调在插件挂载后随时可能被触发 —— `const` 的暂时性死区
   * 会让"加载瞬间正好有个会话在说话"变成一次 ReferenceError。
   */
  const policy = {
    talkSession: tuning.talkSession ?? 'follow',
    hotkey: Array.isArray(tuning.hotkey) ? [...tuning.hotkey] : [],
    micHotkey: Array.isArray(tuning.micHotkey) ? [...tuning.micHotkey] : [],
    inputHotkey: Array.isArray(tuning.inputHotkey) ? [...tuning.inputHotkey] : [],
    // 「我在用 DSH 时停一下」已经交给悬浮窗的 2 号开关管（用户口径）：
    // 这里恒为 true，免得配置里残留的 focusPause=false 让 2 号开关白开。
    focusPause: true,
    focusResume: tuning.focusResume !== false,
    hotkeyWindow: tuning.hotkeyWindow !== false,
    pauseSignal: tuning.pauseSignal === true,
    // 跟随 DSH 启动自动开始陪看（只在挂载时读一次）
    autoWatchOnStart: tuning.autoWatchOnStart === true,
  };

  installSettings(ctx, log, {
    // 会话下拉的选项：设置页打开那一刻现取（会话会开会关，落盘没有意义）
    listSessions: () => listSessionsForSettings(ctx, lastSessionId),
    // 伴生进程（快捷键 / 前台窗口）的现状：可能因为"没有 Python"而根本没起来，
    // 这件事要让用户在设置页里当场看见，而不是"设了快捷键，按下去没反应"
    companionStatus: () => (companion ? companion.status() : { status: 'starting', reason: null }),
    // 存盘成功后热重配（快捷键/焦点开关都是当前进程里的行为）
    onApplied: (next) => applyLiveTuning(next),
  });
  const runner = createRunner({
    ffmpegPath: ffmpeg.path,
    log,
    // 听声音要宿主 `speechToText`（社区用户那边零安装）；给不到就只降级成"没字幕"
    ctx,
    listen: tuning.listen,
    // 变化日志（`~/.dsh/see-now.json` 的 `changeLog`，默认关）
    changeLog: tuning.changeLog,
    // 超省模式：攒够几张图才交（`wakeBatch`，默认 1 = 现在这样）
    wakeBatch: tuning.wakeBatch,
    // 档位映射：这张图里每帧占多大格子（设置页「高级」里那项）
    tierStyle: tuning.tierStyle,
    tierMap: tuning.tierMap,
    // 档位怎么算 / 七道阈值取哪一套（设置页「高级」里的三项）
    tierMode: tuning.tierMode,
    tierCurve: tuning.tierCurve,
    tierThresholds: tuning.tierThresholds,
    // 亮度归一 + 黑边补偿（默认开；关掉 = 回到 0.1.3 的绝对分）
    scoreNormalize: tuning.scoreNormalize,
  });
  disposers.push(() => runner.stop());

  // 声音：和陪看共用同一份 `~/.dsh/voice.json`。**失败一律不抛** ——
  // 声音是可选能力，装坏了最多没声音，不能让看屏幕起不来。
  // 不 await 到阻塞启动：适配器要 import 模块、探测引擎，可能几百毫秒。
  // 启动时挂一次只是热身；真正保证"改完配置就生效"的是每次调用前的 ensureConfiguredVoice。
  ensureConfiguredVoice({ log })
    .then((r) => { if (!r.ok && r.reason !== 'not-configured') log(`声音没挂上：${r.reason}`); })
    .catch(() => { /* 已经在里面兜过了 */ });
  disposers.push(() => { detachAdapters().catch(() => {}); });

  /**
   * 念之前占住"静音窗口"。
   *
   * 不占会怎样：AI 用自己的声音念台词 → 音箱出声 → 回环收回去 → 转成文字 →
   * 被当成"视频里说的" → 模型接着那句话聊下去。自己跟自己聊，停不下来。
   *
   * **`voice: false` 不能省**：那是"只观察、不出声"的订阅者。标成 true 会让
   * `speechSubscribers()` 一直 > 0，展示层就会一直等一个永远不会来的 `spoken`。
   */
  disposers.push(onSpeech((e) => {
    /**
     * `spoken` = **声音真的出来了**（适配器在开始播放那一瞬发的）。
     *
     * 这里必须再占一次窗口：`due` 是"该念了"，慢 TTS 从 due 到出声可能要几十秒，
     * 那期间窗口早过期了，AI 自己的声音会被回环收回去当成视频台词 ——
     * 模型接着自己的话聊，停不下来（issue #33 的自激）。
     *
     * 适配器要是给了 `durationMs`，就按真实时长收口，不再按字数猜。
     */
    if (e?.state === 'spoken') {
      markSpeaking(e.text, e.durationMs ? { durationMs: e.durationMs } : {});
      return;
    }
    if (e?.state === 'due') markSpeaking(e.text);
  }, { voice: false }));

  /**
   * 当前会话 id：从 `session/event` 钩子里拿（`session.header.id`）。
   *
   * 必须有它才能叫醒模型 —— 没有就退化成"看完一张就停"，那正是要修的病。
   * 用**函数**而不是快照：会话 id 由钩子随时更新，闭包里存值会让第一次之后全用旧的。
   */
  let lastSessionId = null;

  /**
   * 省略历史里较早的图（写好 `image/offload` 事件）。手动 action 和自动触发共用。
   *
   * 为什么需要它：一张图进了历史就跟着每一轮请求走，宿主不回收；攒到 600 张
   * 或者 128 MiB 才自动省略一次。想让「只看最近 N 张」提前生效，只能自己写。
   *
   * 写的是宿主的正规事件，**不是改文件** —— 改文件会被 `readImageFile` 的三重校验
   * 判成 ATTACHMENT_CORRUPT（那比删掉更糟：删掉至少能看出是"文件没了"）。
   * 事件一落地，投影就把那些图换成占位文本，之后既不发出去、也能从磁盘删。
   *
   * @param {number} keep - 保留最近几张不省略
   * @param {{silent?: boolean}} [opts] - 自动触发时静默：出错只记日志，不打扰模型
   * @returns {Promise<{ok:boolean, text:string, meta:object}>}
   */
  async function runOffload(limits, { silent = false } = {}) {
    const trigger = Number.isFinite(limits?.trigger) && limits.trigger >= 0 ? Math.floor(limits.trigger) : tuning.imageTrigger;
    const keep = Number.isFinite(limits?.keep) && limits.keep >= 0 ? Math.floor(limits.keep) : tuning.imageKeep;
    if (trigger === 0) {
      return { ok: true, text: '省略是关的（`imageTrigger` = 0）。', meta: { ok: true, offload: { trigger: 0, keep, skipped: 'disabled' } } };
    }
    if (keep >= trigger) {
      return {
        ok: false,
        text: `配置不对：留底（${keep} 张）必须小于触发线（${trigger} 张），否则一触发就白省。`,
        meta: { ok: false, offload: { trigger, keep, reason: 'keep>=trigger' } },
      };
    }

    const sc = serviceOf(ctx, 'sessionController');
    if (!sc?.resolveAgent) {
      return { ok: false, text: '宿主没有 sessionController，没法写会话事件。', meta: { ok: false, offload: { reason: 'no-session-controller' } } };
    }
    const sid = lastSessionId;
    if (!sid) {
      return { ok: false, text: '还不知道是哪个会话（这个进程还没收到过 session/event）。先 `watch` 一次再来。', meta: { ok: false, offload: { reason: 'no-session' } } };
    }

    let resolved;
    try {
      resolved = await sc.resolveAgent(sid);
    } catch (e) {
      resolved = { error: e };
    }
    const session = resolved?.agent?.session;
    if (!session) {
      const why = resolved?.error?.message ?? resolved?.error ?? 'resolve-failed';
      if (silent) log(`自动省略跳过：拿不到会话（${String(why).slice(0, 120)}）`);
      return { ok: false, text: `拿不到这个会话：${String(why).slice(0, 160)}`, meta: { ok: false, offload: { reason: 'resolve-failed' } } };
    }

    /**
     * `snapshotEvents()` 在宿主里标了 deprecated，但它是**唯一**能同步读到当前日志的
     * 公开口子，surface 重放要的就是这份。真被删了会明确报出来，不会静默当成"没有图"。
     */
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null;
    if (!events || !Array.isArray(events)) {
      return { ok: false, text: '这个宿主版本读不到会话日志（`snapshotEvents` 没了），省略做不了。', meta: { ok: false, offload: { reason: 'no-events' } } };
    }

    // 涨到触发线才动手，一次省到只剩 keep 张
    const { triggered, plan } = planOffloadWithTrigger(events, { trigger, keep });
    if (!triggered) {
      return {
        ok: true,
        text: `不用省略：历史里 ${plan.total} 张，还没到 ${trigger} 张的触发线（到线会一次省到 ${keep} 张）。`,
        meta: { ok: true, offload: { ...plan, trigger, target: keep, applied: false } },
      };
    }

    const r = await applyOffload(session, plan.targets, serviceOf(ctx, 'sessions'));
    if (!r.ok) {
      if (silent) log(`自动省略失败：${r.reason}`);
      return { ok: false, text: `省略失败：${r.reason}`, meta: { ok: false, offload: { ...plan, reason: r.reason } } };
    }

    log(`省略了 ${plan.offloading} 张图（保留 ${plan.kept} / 共 ${plan.total}）`);
    return {
      ok: true,
      text: `已省略 ${plan.offloading} 张，保留最近 ${plan.kept} 张`
        + `（${plan.total} 张触发线 ${trigger}）。\n`
        + '- 这些图从现在起换成一段占位文本，**不再进请求、也不再读盘**，磁盘上那份可以删了（`tools/attachments-gc.mjs`）；\n'
        + '- 会话照常继续，模型知道"这里有过图"，只是看不到画面；\n'
        + '- ⚠ 这会**一次性让前缀缓存全量重算**（历史被改了一处），别频繁调。',
      meta: { ok: true, offload: { ...plan, applied: true } },
    };
  }

  /**
   * 自动省略：出图后隔一会儿看一眼，超了就把早的省掉。
   *
   * **节流 30 秒** —— 重放整份会话日志是要花钱的（一次几十毫秒到几百毫秒），
   * 不能每交一张图就跑。出图间隔本身是 15–40 秒，所以实际是"差不多每次出图检查一次"。
   * 用 `setTimeout(0)` 甩出去，**绝不拖慢交付**：模型拿到图的时间不能受这个影响。
   */
  let lastOffloadCheck = 0;
  function maybeAutoOffload() {
    if (!tuning.imageTrigger) return;
    const now = Date.now();
    if (now - lastOffloadCheck < 30_000) return;
    lastOffloadCheck = now;
    setTimeout(() => {
      void runOffload({ trigger: tuning.imageTrigger, keep: tuning.imageKeep }, { silent: true });
    }, 0);
  }
  afterDelivery = maybeAutoOffload;


  /**
   * **逐帧 / 逐场景模式**（默认关）。
   *
   * 开了之后：每留下 1 帧就单独出一张满幅图 → 每换一次场景模型就收到一张图 + 一次唤醒。
   * 这是给演示用的（"每换一个场景就告诉我这是什么"），**平时别开**：
   * 2 秒换一张画面就是每分钟 30 次唤醒，每次一张图（222 token，含音轨条）+ 一轮模型往返。
   *
   * 之所以做成"会话级粘性开关"而不是每次 watch 传参：模型很容易忘，
   * 忘一次就退回多帧拼图，演示当场露馅。所以开一次管到 `scene:false` 或 `stop` 为止。
   */
  let sceneMode = false;
  /** 节奏：calm / normal / dense（粘性）。**这是"省点钱"唯一能真的生效的旋钮。** */
  let paceMode = PACES[tuning.defaultPace] ? tuning.defaultPace : DEFAULT_PACE;
  /**
   * 当前生效的档位（每帧占画布几分之几）。
   *
   * 初值取设置页那一项；模型可以通过 `tier` 参数改它，改了就**粘住**（和 `pace` 一样）。
   * 它只在常规模式下进 `opts.strategy` —— 逐帧模式必须整幅，不能被这个覆盖。
   */
  let tierMode = TIER_STYLES.includes(tuning.tierStyle) ? tuning.tierStyle : 'standard';
  /** 模型能用 `tier` 选的四个值（不含 `custom`，理由见下面处理 `args.tier` 那段）。 */
  const TIER_MODES = ['standard', 'native', 'full', 'compact'];
  /**
   * **上一次真正生效的 source 类型**。`cutAbs` 的自动选择要靠它，不能看本次请求的 `src`：
   * 第二次 `watch` 通常不带 path（接着看同一段），那时 `src` 是 undefined，判定就会从
   * "文件回放"翻回默认档 —— 参数一变 runner 就重启采集，画面从 0 秒重来。
   * 实测 e2e「连看两次，第二张不会重复第一张」就是这么挂的。
   */
  let lastSrcKind = null;
  /** 循环是按哪个模式起的 —— 模式变了要重建，不然唤醒节奏还是旧的 */
  let loopScene = null;
  /** 切模式时那一句说明：下一次工具结果里带给模型，然后清掉 */
  let pendingModeNote = '';
  /**
   * 上一次告诉模型的区域。变了才说一句 —— 每张图都重复"你在看 x,y,w,h"是噪音，
   * 但**变了不说**更糟：模型会拿一块区域的画面去回答整屏的问题。
   */
  let lastRegionKey = regionText(loadRegion());

  /**
   * 把模型的**正文**也记进小窗那条流。
   *
   * 为什么：小窗原来只有 `say` 气泡和用户自己打的字 —— 模型正常回的话一句都不在
   * 里面，于是它只好跟用户解释"我们的对话不会记录在窗口"（2026-11-03 社区反馈）。
   * 记录本来就该是完整的：窗开着的时候，把这一轮的正文追加进 `chat.jsonl`
   * （**不朗读** —— 只有 `say` 才念，这条只是留痕）。
   *
   * 三条护栏：
   *   - 窗没开着就不写：没人在看，写了只是让文件长胖；
   *   - `say` 已经进过窗的（正文包含那句 say）就跳过，不然用户会看到同一句两遍；
   *   - 超长截断到 600 字：小窗是气泡流，不是终端。
   *
   * 第四条（2026-11 加）：**绑了会话就只记那个会话的正文**。不绑的时候是"谁说话都
   * 往里灌"—— 用户只跟 A 聊的时候，B 窗口的正文会莫名其妙出现在小窗里，看着像串台。
   */
  const mirrorAssistantText = (event, sessionId = null) => {
    try {
      if (event?.type !== 'assistant/message') return;
      const bound = boundSession();
      if (bound && sessionId && sessionId !== bound) return;
      const payload = event.data ?? event;
      const blocks = payload?.message?.content;
      if (!Array.isArray(blocks)) return;
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text.length < 2) return;
      if (!windowAlive()) return;
      const said = lastSaidText();
      const norm = (s) => String(s).replace(/\s+/g, '');
      if (said && Date.now() - said.at < 120_000 && norm(text).includes(norm(said.text))) return;
      appendChat('assistant', text.length > 600 ? `${text.slice(0, 600)}…` : text);
    } catch { /* 记录失败绝不能影响会话本身 */ }
  };
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session, event) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
        // 2026-11-09 哥哥定的：小窗气泡只放 `say`，正文不放。
        // 原话「有些是你想给我听的，有些是你自己的思考 —— 气泡只要播报你想 say 的就行，
        // 和语音播报一样的内容，其他的不用放出来」。
        // 正文 DSH 自己的会话记录里是完整的，这里不再镜像，免得气泡变成流水账。
        // 要开回来就把下面这行的注释去掉（mirrorAssistantText 本体保留）。
        // mirrorAssistantText(event, id ?? null);
        void mirrorAssistantText;
      });
      if (typeof off === 'function') disposers.push(off);
    } catch (e) {
      // 拿不到就退化成"只能手动调"，但要说出来 —— 静默失败是这类 bug 的温床
      log(`session/event 钩子失败：${e?.message ?? e}`);
    }
  }

  /** 正在跑的常驻循环（同一时刻只有一个） */
  let loop = null;
  /**
   * 最近一次从伴生进程听到的焦点状态，和"被 DSH 抢焦点打断"的现场 `{owner, at}`。
   *
   * 两个都声明在这里（而不是各自用到的地方）：`syncWindowStatus()` 同时读它们，
   * 而它挂在 `ensureLoop` / `startWatching` 这些更早的函数上 —— `let` 是暂时性死区，
   * 声明放在后面会在"刚挂载就起循环"那一瞬间炸 ReferenceError。
   */
  let focusFocused = false;
  let focusPaused = null;
  /**
   * "焦点暂停"是否已经上膛。
   *
   * 用户在 DSH 里按快捷键开陪看时，焦点事件会立刻回一个"DSH 在前台" ——
   * 直接照办就会把刚起来的陪看当场按停，看起来像快捷键坏了。所以只有
   * **真的切走过一次**（失焦）之后才允许"回来就停"。
   */
  let focusArmed = false;
  const stopLoop = (reason = '手动') => {
    if (!loop) return;
    const wasStopped = loop.stopped();
    loop.dispose();
    loop = null;
    if (!wasStopped) log(`循环停了（${reason}）`);
  };
  disposers.push(() => stopLoop('插件卸载'));

  /**
   * 起循环（幂等，按会话）。
   *
   * **这是"看完一张就停"和"一直看下去"的分界线**：以前 `watch` 返回一张图就结束了，
   * 模型回完话自然收工。现在 watch 返回第一张图之后，插件自己接着跑，
   * 攒够下一张就叫醒模型 —— 直到用户关窗。
   *
   * **不接 `run.signal`**：那是单次调用的取消通知，挂上去等于"这一轮结束循环就死"
   * （实测表现就是"它答一句就没下文了"）。取消/超时在 `runner.watch()` 里自己判。
   *
   * **换会话要换循环**：`lastSessionId` 会被任何一个会话的 `session/event` 顶掉，
   * 沿用旧循环就会把话投到别的会话里（"我在这个窗口说话，另一个窗口回答"）。
   *
   * **owner 由调用方传入的优先**：`watch` 是阻塞的（15~40 秒），等它返回时
   * `lastSessionId` 可能已经被另一个会话的事件顶掉了。所以 `watch` 会在**开始等待前**
   * 把当时的会话 id 记下来传进来，而不是让这里现取（issue #1 的归属竞争）。
   */
  const ensureLoop = (owner = null) => {
    /**
     * **非实时的文件回放不起常驻循环。**
     *
     * 循环的意义是"实时源一直在产帧，攒够一张就叫你"。而 `source:"file"` 是调试用的：
     * 有限、放完就停，模型自己调 `watch` 就能一段段取完。给它起循环的后果是
     * 24 秒解出 1955 帧、刷出几十张图、把模型反复叫醒（社区实报）。
     */
    const st0 = runner.status();
    const finiteFile = st0?.lastSource?.kind === 'file' && st0?.lastSource?.realtime !== true;
    if (finiteFile) {
      if (loop) stopLoop('文件回放（有限，不需要循环）');
      loopScene = null;
      return null;
    }
    const sid = owner ?? lastSessionId;
    // 模式和节奏都影响唤醒间隔，任一个变了都得重建循环
    const key = sceneMode ? 'scene' : paceMode;
    if (loop && !loop.stopped() && loop.state().session === sid && loopScene === key) return loop;
    if (loop) stopLoop(loop.state().session ? '换会话' : '重建');
    loopScene = key;
    loop = startLoop({
      ctx,
      sessionId: sid,
      getSessionId: () => lastSessionId,
      runner,
      log,
      scene: sceneMode,
      // 逐帧模式出图最密，4 秒是"一句短话念得完"的下限；
      // 常规按节奏走（normal 15 秒 / calm 30 秒）—— 8 秒一次太吵，实报过。
      wakeMinGapSec: sceneMode ? 4 : PACES[paceMode].wakeGapSec,
      // 收工线（叫醒次数上限 / 空闲分钟）可由 ~/.dsh/see-now.json 覆盖
      tuning,
      onStop: (reason) => {
        // 循环自己收工（闲置、叫醒没人接、采集断了、窗被关）也是一次"暂停"，
        // 用户开了那个开关就该收到一条 —— 否则模型那边只会看到画面不动了。
        void signalPause(reason);
        if (reason === 'window-closed') {
          /**
           * 关窗 = **所有开关关闭**（用户口径第 5 条）：
           * 总开关停（下面 stopWatching 已经做了）、二号关（focusResume=false）、
           * 三号解除（focusLock=false）。写进盘里，下次开窗读到的就是全关。
           */
          try {
            rememberWindowSwitches({
              resume: Boolean(policy.focusResume),
              focusLock: readWindowFocusLock(),
            }, { log });
          } catch { /* 记不住就按默认开 */ }
          try { writeTuning({ focusResume: false }, { log }); } catch { /* 写不进也要停 */ }
          try { setWindowFocusLock(false, { log }); } catch { /* 同上 */ }
          try { applyLiveTuning(readTuning()); } catch { /* 忽略 */ }
          // 用户关窗 = 不看了。**落进待领说明**，下一次工具结果带走。
          // 不能写 chat.jsonl：窗已经关了，那条流没人看，模型也拿不到 ——
          // 实测会连写两条，而模型还在说"我还在看"。
          try { runner.note(HANGUP_NOTE); } catch { /* 记不住也要停 */ }
          // **必须用 hangUp 而不是 stop**：stop 只是停采集，下一条 watch 会立刻
          // 重启并把窗重新开起来 —— 用户体感是"关掉又弹出来，只能卸载插件"。
          try { runner.hangUp(); } catch { /* 已经停了 */ }
          return;
        }
        try { runner.stop(); } catch { /* 已经停了 */ }
        // 循环自己收工时，窗口状态行也得跟着变回"没在陪看"
        syncWindowStatus();
      },
    });
    log(`常驻循环已启动（会话 ${sid ?? '未知'}）`);
    syncWindowStatus();
    return loop;
  };

  // ════════════════════════════════════════════════════════════════════════
  // 小窗绑谁 / 快捷键 / 焦点
  //
  // 这三件事凑在一起不是巧合：它们都在回答同一个问题 —— **"陪看"这个动作该属于谁、
  // 什么时候该在**。以前答案是固定的（最后说话的那个会话，用户点工具或关窗为止）；
  // 现在用户能说了算：绑给谁（talkSession）、怎么喊停喊开（hotkey）、
  // 我在用 DSH 的时候它该不该识相地退开（focusPause / focusResume）。
  // ════════════════════════════════════════════════════════════════════════

  /** 绑定的会话 id；`null` = 跟随当前会话（0.2.0 的老行为）。 */
  function boundSession() {
    const want = String(policy.talkSession ?? '').trim();
    return want && want !== 'follow' ? want : null;
  }

  /**
   * 小窗打的字、陪看叫醒、循环的 owner —— 都该投给谁。
   *
   * 绑定时就是那个会话（用户明确选了）；不绑时才退化成"最后说话的那个"。
   * 注意**绑定优先于 lastSessionId**：用户绑 A 之后又在 B 里聊，陪看仍然属于 A ——
   * 这正是"绑定"的意义，否则它跟不绑没区别。
   */
  function talkTarget() {
    return boundSession() ?? lastSessionId;
  }

  /** 陪看是不是"活着"：循环在跑，或者采集在跑（起手那几秒循环还没建出来）。 */
  function watchingNow() {
    if (loop && !loop.stopped()) return true;
    try { return Boolean(runner.status()?.running); } catch { return false; }
  }

  let startingWatch = false;

  /**
   * 起陪看（快捷键、焦点回来、都给这一个出口）。
   *
   * 为什么是 `runner.start()` 而不是 `runner.watch()`：`watch` 是给模型的阻塞调用，
   * 会等出一张图才返回（15~40 秒）；快捷键要求的是"按下去就动"。`start()` 只开采集，
   * 第一张图由常驻循环攒 —— 模型下一轮 `watch` 或叫醒时就会看到它。
   *
   * **窗由这里自己支起来**：循环不开窗（开窗是 `watch`/`peek` 的活），不支的话
   * 用户按了快捷键什么都看不见，连"已经开始陪看"的 meta 气泡都没地方显示。
   */
  /**
   * 把"陪看 / 焦点 / 自动续看"这三件事写给悬浮窗（`watch-window.json` 的 `status`）。
   *
   * 为什么走文件而不是协议：窗口每 250ms 本来就在看这个文件的 mtime（样式、弹幕
   * 都靠它），多写几个布尔不增加任何一条新链路；反过来"静音"是窗口写、这里读，
   * 一个文件两头读写，谁都不用新增协议。
   */
  function syncWindowStatus(extra = {}) {
    try {
      setWindowStatus({
        watching: watchingNow(),
        focused: extra.focused ?? focusFocused,
        pausedByFocus: Boolean(focusPaused),
        resume: policy.focusResume,
      }, { log });
    } catch (err) {
      log(`写窗口状态失败：${err?.message ?? err}`);
    }
  }

  async function startWatching(why = '') {
    if (startingWatch) return { ok: false, reason: 'busy' };
    startingWatch = true;
    try {
      const owner = talkTarget();
      /**
       * 没有会话就别开采集。
       *
       * 循环的 owner 是"叫醒谁"，没有它每一拍叫醒都会失败（`wakeSession` 拿不到
       * sessionId），用户看到的是一串"叫醒失败"的日志和一张没人接的图。
       * 这条只在"刚开 DSH 还没打开任何会话"时出现 —— 说出来比默默开始好。
       */
      if (!owner) {
        log('没有可投递的会话，陪看不启动');
        appendSpoken('meta', '（还没挑好跟谁说 —— 先在 DSH 里打开一个会话，或者在小窗设置里绑定一个。）', { speak: false });
        return { ok: false, reason: 'no-session' };
      }
      // 用户框过的那块要跟着走：不然"只看这一块"的用户一按快捷键就跳回整屏
      let src = { kind: 'screen' };
      try {
        const saved = loadRegion();
        if (saved) src = { ...src, region: saved };
      } catch { /* 没有区域就当整屏 */ }
      /**
       * **先把窗支起来**，再去开采集。
       *
       * 反过来不行：采集起完要等模型下一轮 `watch` 才会开窗，中间这几秒用户按了
       * 快捷键却看不到任何反应（窗是关着的话，连 meta 气泡都没地方显示）——
       * 那看起来就是"这个快捷键坏了"。开窗失败不影响陪看，只是少了界面。
       */
      let windowNote = '';
      // **已经在跑就把窗叫到前面**：以前只在"没窗"时才开窗，
      // 窗还活着但被别的窗口压住时，按快捷键等于什么都没发生（用户实报）。
      if (windowAlive()) {
        try {
          appendFileSync(join(chatDir(), 'window-outbox.jsonl'),
            `${JSON.stringify({ type: 'show', at: Date.now() })}\n`, 'utf8');
        } catch { /* 写不进就算了 */ }
      } else if (policy.hotkeyWindow) {
        try {
          const w = await openWindow({ force: true, log });
          if (!w?.ok) windowNote = `；窗没开起来（${w?.reason ?? '未知'}）`;
          else if (!w?.already) restoreWindowSwitches();
        } catch (err) {
          windowNote = `；窗没开起来（${err?.message ?? err}）`;
        }
      }
      // **没开悬浮窗就不许开始陪看**（用户要求）：
      // 开窗那一步失败、或者窗口根本不在，就直接拒绝，别在后台悄悄跑。
      if (!windowAlive()) {
        const why = windowNote ? `没开悬浮窗${windowNote}` : '没开悬浮窗';
        log(`陪看没起来：${why}`);
        appendSpoken('meta', `（${why}）`, { speak: false });
        return { ok: false, reason: why };
      }
      let r = null;
      try { r = await runner.start({ src }); } catch (err) { r = { error: err }; }
      if (r?.error || r?.ok === false) {
        const why2 = r?.error?.message ?? r?.reason ?? String(r?.error ?? '未知原因');
        log(`陪看没起来：${why2}`);
        appendSpoken('meta', `（没起来：${why2}${windowNote}）`, { speak: false });
        return { ok: false, reason: why2 };
      }
      const lp = ensureLoop(owner);
      const tail = lp ? '' : '；有限文件回放不起循环，模型看一张是一张';
      /**
       * 起手时 DSH 本来就在前台 → 先"别武装"焦点暂停。
       *
       * 不这么做的话，用户按快捷键的那一刻焦点事件立刻打回来，刚起来的陪看
       * 被自己按停 —— 看起来就是"快捷键点了没反应"。等真的切走过一次
       * （`onFocusChanged(false)`）再武装，才符合"我一回来它就停"的本意。
       */
      focusArmed = !focusFocused;
      syncWindowStatus();
      appendSpoken('meta', `（开始陪看${why ? `：${why}` : ''}${windowNote}${tail}）`, { speak: false });
      log(`陪看开始${why ? `（${why}）` : ''}，会话 ${owner ?? '未知'}`);
      return { ok: true };
    } finally {
      startingWatch = false;
    }
  }

  let pauseSignalAt = 0;

  /**
   * 陪看停了 → 给那边发**一条**消息（`pauseSignal` 打开时才发）。
   *
   * 附上**最后交付过的画面**（有才附）和**暂停原因**：模型靠它分清"开关暂停 /
   * 关窗 / 焦点判定暂停"，也不会把更早的画面当成现在的现场。
   *
   * 3 秒内只发一条：焦点抖动（Alt-Tab 连切两下）会连着停两次，别变成两条。
   * 失败只记日志 —— 一条通知不该把停陪看这件事卡住。
   */
  const PAUSE_REASONS = {
    '快捷键': '用户按了开关',
    'DSH 拿到焦点': 'DSH 获得焦点（焦点判定暂停）',
    '悬浮窗标题栏': '悬浮窗标题栏开关',
    'window-closed': '悬浮窗被关闭',
  };
  async function signalPause(why) {
    if (policy.pauseSignal !== true) return;
    const sid = talkTarget();
    if (!sid) return;
    const now = Date.now();
    if (now - pauseSignalAt < 3000) return;
    pauseSignalAt = now;
    const reason = PAUSE_REASONS[why] ?? `自动收工（${why}）`;
    const hasImage = Boolean(lastSeenSheet?.ref);
    const text = `[看屏幕·暂停] 陪看停下来了：${reason}。\n`
      + (hasImage
        ? '下面附的是最后一次看到的画面。你不需要回什么 —— 用户回来会接着看（或者他叫你）。'
        : '（这次还没有交付过画面，没有图可附。）你不需要回什么 —— 用户回来会接着看（或者他叫你）。')
      + '这条之后不会再刷新，别把更早的画面当成现在的现场。';
    try {
      const r = await wakeSession(ctx, {
        sessionId: sid,
        text,
        image: hasImage ? lastSeenSheet.ref : null,
      });
      if (!r?.ok) log(`暂停通知没发出去：${r?.reason ?? '未知'}`);
    } catch (err) {
      log(`暂停通知没发出去：${err?.message ?? err}`);
    }
  }

  /** 停陪看：循环和采集一起停（只停一个会留下"还在截屏但没人看"的怪状态）。 */
  function stopWatching(why = '手动') {
    const was = watchingNow();
    stopLoop(why);
    try { runner.stop(); } catch { /* 已经停了 */ }
    focusArmed = false;
    syncWindowStatus();
    if (was) void signalPause(why);
  }

  let hotkeyBusy = false;

  /**
   * 快捷键的语义是**开关**：在看就停，没看就开始。
   *
   * `hotkeyBusy` 挡连击：`startWatching` 里有 await，按住不放会连开好几次，
   * 每次 `runner.start` 都要重建 ffmpeg 管线。
   */
  async function toggleByHotkey() {
    if (hotkeyBusy) return;
    hotkeyBusy = true;
    try {
      // **快捷键的第一职责是"把窗叫出来"**：不管接下来是开始还是停止，
      // 都先把窗口显示出来 —— 否则已经开着的窗被别的程序压住时，
      // 按快捷键看起来什么都没发生（用户实报）。
      try {
        if (windowAlive()) {
          appendFileSync(join(chatDir(), 'window-outbox.jsonl'),
            `${JSON.stringify({ type: 'show', at: Date.now() })}\n`, 'utf8');
        } else if (policy.hotkeyWindow) {
          const w = await openWindow({ force: true, log });
          if (w?.ok && !w?.already) restoreWindowSwitches();
        }
      } catch { /* 开窗失败不影响下面的开关 */ }
      if (watchingNow()) {
        stopWatching('快捷键');
        appendSpoken('meta', '（停下来了。再按一次接着看。）', { speak: false });
      } else {
        await startWatching('快捷键');
      }
    } finally {
      hotkeyBusy = false;
    }
  }

  const micBusy = { value: false };
  const inputBusy = { value: false };

  /**
   * 「写 control + 窗没开就拉窗」的公共路：窗口启动时会回放最后 60 条事件，
   * 所以先写事件再拉窗，窗口一出来 control 照样执行。
   */
  async function controlByHotkey(action, busyRef, label) {
    if (busyRef.value) return;
    busyRef.value = true;
    try {
      const written = windowControl(action);
      if (!written) {
        log(`${label}：写 window-events.jsonl 失败`);
        return;
      }
      if (!windowAlive()) {
        try {
          const w = await openWindow({ force: true, log });
          if (w?.ok && !w?.already) restoreWindowSwitches();
        } catch (err) {
          log(`${label}：拉窗失败（${err?.message ?? err}），事件已写入，等窗口起来执行`);
        }
      }
    } finally {
      busyRef.value = false;
    }
  }

  /**
   * 麦克风快捷键：点按切换录音 —— 和悬浮窗上的麦克风按钮同一条路。
   */
  function toggleMicByHotkey() {
    void controlByHotkey('micToggle', micBusy, '麦克风快捷键');
  }

  /**
   * 输入条快捷键：唤起/收起输入条 —— 和悬浮窗上的「字」按钮同一条路。
   */
  function toggleInputByHotkey() {
    void controlByHotkey('inputToggle', inputBusy, '输入条快捷键');
  }

  /**
   * 被"DSH 拿到焦点"打断时的现场：`{ owner, at }`；没被打断是 `null`。
   *
   * 记 owner 是为了续看时回到**同一个会话** —— 用户切回来时 `lastSessionId`
   * 可能已经被别的会话顶掉了（比如他刚才在另一个窗口点了两下）。
   *
   * （变量本身声明在 `let loop = null` 旁边，见那里的说明。）
   */

  /**
   * 前台窗口换了主人。
   *
   * 两个开关是**独立的**：`focusPause` 决定"我在用 DSH 时要不要停"，
   * `focusResume` 决定"我切走之后要不要自己接着看"。只开前者＝"你一碰 DSH 它就收工"，
   * 两个都开＝"你忙你的，忙完它接着看"。所以打断现场必须存在 `focusPaused` 里，
   * 不能只靠"当前有没有在跑"判断 —— 用户可能自己按快捷键停了，那就不是被打断。
   */
  /**
   * 开窗后把二 / 三号开关恢复成"上次开窗时"的状态。
   *
   * 关窗那一刻已经把实时值清零（三个开关全关），记忆存在
   * `watch-window.json` 的 `lastResume` / `lastFocusLock` 里。
   * 只在**新进程**起来后调（`already` 说明是原来那个窗，不动用户的现场）。
   */
  function restoreWindowSwitches() {
    try {
      const mem = rememberedWindowSwitches();
      const res = writeTuning({ focusResume: mem.resume }, { log });
      if (res?.ok) applyLiveTuning(readTuning());
      setWindowFocusLock(mem.focusLock, { log });
      log(`开窗：恢复开关（二号 ${mem.resume ? '开' : '关'}，三号 ${mem.focusLock ? '锁定' : '解锁'}）`);
    } catch (err) {
      log(`恢复开关失败：${err?.message ?? err}`);
    }
  }

  function onFocusChanged({ focused } = {}) {
    focusFocused = Boolean(focused);
    /**
     * 三号开关（`focusLock`，窗口标题栏那个圆）：
     * - 红 = **锁住焦点判定**，陪看只认一号总开关；
     * - 绿 = 交回二号（`focusResume`）决定 —— 焦点在 DSH 就停、跑开就续。
     * 二号关掉时同样不做判定，只把"焦点状态"显示出去（用户口径第 4 条）。
     */
    const focusLocked = readWindowFocusLock();
    const focusActive = !focusLocked && Boolean(policy.focusResume);
    if (!focusActive || !policy.focusPause) {
      // 没开"焦点暂停"/被判据锁住 也照样把焦点写过去：状态行要显示"焦点：DSH / 别处"
      syncWindowStatus({ focused: focusFocused });
      return;
    }
    if (focused) {
      if (focusPaused) return;
      /**
       * 还没"武装"就回来 = 用户根本没离开过（刚按快捷键那一下的焦点回执）。
       * 这时停手等于把快捷键按成空操作，所以只更新状态、不动陪看。
       */
      if (!focusArmed) {
        syncWindowStatus({ focused: true });
        return;
      }
      if (!watchingNow()) return;
      let owner = talkTarget();
      try {
        const st = loop?.state?.();
        if (st?.session) owner = st.session;
      } catch { /* 循环状态取不到就用 talkTarget */ }
      focusPaused = { owner, at: Date.now() };
      stopWatching('DSH 拿到焦点');
      /**
       * 只写状态、不写气泡。
       *
       * 用户原话：这里要的是状态，不是解释句。顶栏那行已经写着「焦点DSH，暂停 ·
       * 已开启恢复陪看」，再往 chat.jsonl 塞一条同样的气泡，就是同一句话说两遍。
       */
      log('焦点回到 DSH，陪看暂停');
      return;
    }
    // 失焦：真的切走了 —— 从这一刻起"回来就停"才成立
    focusArmed = true;
    // 只有"确实是我打断的"才续看
    if (!focusPaused) {
      syncWindowStatus({ focused: false });
      return;
    }
    const { owner } = focusPaused;
    focusPaused = null;
    if (!policy.focusResume) {
      syncWindowStatus({ focused: false });
      log('焦点离开 DSH，自动续看关着，不续');
      return;
    }
    log('焦点离开 DSH，按设置自动续看');
    syncWindowStatus({ focused: false });
    void startWatching('焦点回来了');
  }

  /**
   * 伴生进程：全屏快捷键 + 前台窗口检测。
   *
   * 这两件事宿主都没给 API（cordis 的服务目录里没有 globalShortcut，也没有焦点事件），
   * 只能落到一个 Python 小进程上：ctypes 轮询 `GetAsyncKeyState` 和
   * `GetForegroundWindow`，一行一个 JSON 回报。**不用 RegisterHotKey** 是为了不和
   * 别的程序抢键（抢输了就完全没反应，而且报错还得等系统弹窗）。
   */
  companion = createCompanion({
    log,
    onHotkey: () => { void toggleByHotkey(); },
    onMicHotkey: () => { void toggleMicByHotkey(); },
    onInputHotkey: () => { void toggleInputByHotkey(); },
    onFocus: onFocusChanged,
    // 认"DSH"认的是可执行文件路径：Electron 每个进程 pid 都不同，exe 是同一个
    appExe: process.execPath,
  });
  disposers.push(() => {
    try { companion.stop(); } catch { /* 已经退了 */ }
  });

  /**
   * 设置页存盘后立刻生效的部分。
   *
   * 注意这里**再读一遍** `next`（`readTuning()` 的完整快照）而不是增量 ——
   * 因为 `patch` 只管改过的键，而 policy 需要的是"改完之后整体是什么样"。
   */
  function applyLiveTuning(next) {
    if (!next || typeof next !== 'object') return;
    const prevTalkSession = policy.talkSession;
    policy.talkSession = String(next.talkSession ?? 'follow') || 'follow';
    if (String(prevTalkSession ?? '') !== String(policy.talkSession ?? '')) {
      resetChatFeedForSwitch();
    }
    policy.hotkey = Array.isArray(next.hotkey) ? [...next.hotkey] : [];
    policy.micHotkey = Array.isArray(next.micHotkey) ? [...next.micHotkey] : [];
    policy.inputHotkey = Array.isArray(next.inputHotkey) ? [...next.inputHotkey] : [];
    policy.focusPause = next.focusPause === true;
    policy.focusResume = next.focusResume !== false;
    policy.hotkeyWindow = next.hotkeyWindow !== false;
    policy.pauseSignal = next.pauseSignal === true;
    // 只管下一次启动；已经在跑的这一程不追认
    policy.autoWatchOnStart = next.autoWatchOnStart === true;
    /**
     * **换了绑定，正在跑的循环也得换主人。**
     *
     * 循环的 owner 是创建时定死的（`startLoop({sessionId})`），用户在中途改绑定
     * 如果不重建，图会继续投给旧会话 —— 和他刚刚在设置页做的选择正好相反。
     * `ensureLoop` 自己会发现 session 不一样并重建，这里只需要叫它一声。
     */
  /**
   * **换绑定会话 = 换一份记录。**
   *
   * 小窗显示的 `chat.jsonl` 是全局一份，不按会话分。换了绑定如果不清理：
   * 1. 旧会话的对话继续留着小窗里；
   * 2. 更糟的是 `pumpBoundChat` 只按时间过滤（120 秒），
   *    旧会话里你刚打的字会被当成新会话的话**再投一次**。
   *
   * 所以这里在切换的瞬间把这份文件清空，并写一条分隔标记。
   */
  function resetChatFeedForSwitch() {
    try {
      const file = join(chatDir(), 'chat.jsonl');
      const marker = JSON.stringify({
        role: 'system',
        text: '（已切换绑定会话）',
        at: Date.now(),
      });
      writeFileSync(file, `${marker}\n`, 'utf8');
      try {
        appendFileSync(join(chatDir(), 'window-outbox.jsonl'),
          `${JSON.stringify({ type: 'resetFeed', at: Date.now() })}\n`, 'utf8');
      } catch { /* 窗口没开就算了 */ }
      log('换绑定：已清空小窗记录，避免旧会话的话投给新会话');
    } catch (err) {
      log(`换绑定清屏失败：${err?.message ?? err}`);
    }
  }

    if (watchingNow() && loop && !loop.stopped() && loop.state?.().session !== talkTarget()) {
      try { ensureLoop(talkTarget()); } catch (err) { log(`换绑定失败：${err?.message ?? err}`); }
    }
    companion.setConfig({
      hotkey: policy.hotkey, micHotkey: policy.micHotkey, inputHotkey: policy.inputHotkey,
      focus: policy.focusPause,
    });
    // 小窗悬停说明里要显示这两条快捷键：写进窗口读的那份文件，改了立刻热生效
    setWindowHotkeys({ mic: policy.micHotkey, input: policy.inputHotkey }, { log });
    // 关掉"焦点暂停"的同时清现场：不然下一次失焦会莫名其妙续看一轮
    if (!policy.focusPause) focusPaused = null;
    syncChatBridge();
    // 自动续看这一项直接画在窗口状态行上，改完就得让窗口知道
    syncWindowStatus();
    log(`设置已生效：会话 ${policy.talkSession}，快捷键 ${hotkeyText(policy.hotkey) || '不设'}，`
      + `麦克风快捷键 ${hotkeyText(policy.micHotkey) || '不设'}，`
      + `输入条快捷键 ${hotkeyText(policy.inputHotkey) || '不设'}，`
      + `焦点暂停 ${policy.focusPause ? '开' : '关'}，自动续看 ${policy.focusResume ? '开' : '关'}，`
      + `按键拉窗 ${policy.hotkeyWindow ? '开' : '关'}`);
  }

  /**
   * 小窗打字 → 目标会话。
   *
   * 绑了会话、而且**循环没在跑**的时候才有这个任务：循环在跑时由它的 `pollUser`
   * 负责把用户说的话投出去（那条路还带"先说话再干活"的插话说明）。两边
   * **共用同一个游标**（`chatWatcherShared` 是进程级单例），谁先取谁拿 ——
   * 所以这里必须让开，否则同一条消息会被投两次。
   *
   * 不绑定的时候这里什么都不做：老行为是"窗口打的字只有模型主动 watch 才看得见"，
   * 改了会影响没绑会话的用户。
   */
  const chatPoll = chatWatcherShared();
  let chatBridgeTimer = null;

  function syncChatBridge() {
    const need = Boolean(boundSession());
    if (need && !chatBridgeTimer) {
      chatBridgeTimer = setInterval(pumpBoundChat, 300);
      chatBridgeTimer.unref?.();
    } else if (!need && chatBridgeTimer) {
      clearInterval(chatBridgeTimer);
      chatBridgeTimer = null;
    }
  }

  function pumpBoundChat() {
    const sessionId = boundSession();
    if (!sessionId) return;
    // 只在这两件事都不在跑的时候接管：循环有自己的 pollUser；模型可能正卡在
    // 一次阻塞的 `watch` 里（`chatWaiterCount() > 0`），那条路要负责"先说话再干活"，
    // 抢过来只会变成一条排队等它忙完的 followup，用户看到的是"说了没反应"。
    if (loop && !loop.stopped()) return;
    if (chatWaiterCount() > 0) return;
    let entries = null;
    try { entries = chatPoll(); } catch { return; }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry?.role !== 'user') continue;
      const text = String(entry.text ?? '').trim();
      if (!text) continue;
      // 游标刚建立时可能一口气带出几分钟前的话，那些不必补投
      const at = Number(entry.at);
      if (Number.isFinite(at) && at > 0 && Date.now() - at > 120_000) continue;
      noteInterjected(text);
      const prompt = `[小窗·用户说话] 「${text.slice(0, 400)}」\n`
        + '**先说话，再干活** —— 用 `say` 回他（普通回复他一个字都看不到，也不会被念）。'
        + '要同时看一眼就调 `see_now({action:"peek"})`，图马上给你。';
      void wakeSession(ctx, { sessionId, text: prompt }).then((r) => {
        if (r && r.ok === false) log(`小窗说话没投出去：${r.reason}`);
      }).catch(() => { /* wakeSession 自己不抛，这里兜的是 then 里抛 */ });
    }
  }

  disposers.push(() => {
    if (chatBridgeTimer) {
      clearInterval(chatBridgeTimer);
      chatBridgeTimer = null;
    }
  });

  // 挂载时就把用户存过的配置交给伴生进程（否则要等第一次存盘才生效）
  syncChatBridge();
  companion.setConfig({
    hotkey: policy.hotkey, micHotkey: policy.micHotkey, inputHotkey: policy.inputHotkey,
    focus: policy.focusPause,
  });
  setWindowHotkeys({ mic: policy.micHotkey, input: policy.inputHotkey }, { log });
  // 顶栏也要一开始就说实话：刚挂载时窗口可能已经开着（上次没关），
  // 不写这一下它会一直显示默认的「没在陪看 · 焦点：别处」。
  syncWindowStatus();

  // 跟随 DSH 启动自动开始陪看：等会话数据就绪后带重试地起。
  // 冷启动时 `lastSessionId` 一定还是空（它只在会话活动时写入），所以拿不到
  // "最近会话"就从会话列表里挑 updatedAt 最新的顶上；60 秒内都没有可用会话才放弃。
  if (policy.autoWatchOnStart) {
    let autoStarted = false;
    let autoTries = 0;
    const AUTO_MAX_TRIES = 12;   // 4 秒首发 + 每 5 秒重试，最多约 60 秒
    let autoTimer = null;
    const tryAutoWatch = async () => {
      if (autoStarted) return;
      autoTries += 1;
      let owner = talkTarget();
      if (!owner) {
        try {
          const sessions = await listSessionsForSettings(ctx, null);
          const best = sessions.filter((s) => s.at).sort((a, b) => b.at - a.at)[0];
          if (best) owner = best.id;
        } catch { /* 列表拿不到就等下一轮重试 */ }
      }
      if (!owner) {
        if (autoTries >= AUTO_MAX_TRIES) {
          log('自动陪看放弃：启动 60 秒内没有可用会话');
        } else {
          autoTimer = setTimeout(() => { void tryAutoWatch(); }, 5000);
        }
        return;
      }
      autoStarted = true;
      // follow 模式且"最近会话"为空：把挑出来的会话记下来，之后的跟随才有据可依
      if (!lastSessionId && !boundSession()) lastSessionId = owner;
      log(`自动开始陪看（DSH 启动），会话 ${owner}`);
      void startWatching('DSH 启动自动陪看');
    };
    autoTimer = setTimeout(() => { void tryAutoWatch(); }, 4000);
    disposers.push(() => {
      if (autoTimer) clearTimeout(autoTimer);
    });
  }

  /**
   * 盯住 `~/.dsh/see-now.json`：文件一变就把新值吃进来。
   *
   * **为什么不能只靠设置页**：设置页保存走 HTTP 接口，那条路本来就会回调
   * `applyLiveTuning`；但配置文件是明文、文档里也写着"手改同样有效"，用户完全可能
   * 直接改它。以前那种改法要重启 DSH 才生效，而**界面读的是文件、运行的是内存里的
   * 旧值** —— 于是出现"下拉框明明显示绑的是 A，小窗的字还是投给了 B"，这种最难查。
   * 加个文件监听，两条路都即时。
   *
   * 用 `watchFile`（轮询 stat）而不是 `watch`：Windows 上 `writeTuning` 是
   * 临时文件 + rename，`watch` 盯的是旧 inode，改一次之后就哑了。
   */
  const policyKey = () => JSON.stringify([
    policy.talkSession, policy.hotkey, policy.focusPause, policy.focusResume, policy.hotkeyWindow,
    policy.pauseSignal, policy.autoWatchOnStart,
  ]);
  const tuningKey = (t) => JSON.stringify([
    String(t?.talkSession ?? 'follow') || 'follow',
    Array.isArray(t?.hotkey) ? t.hotkey : [],
    t?.focusPause === true,
    t?.focusResume !== false,
    t?.hotkeyWindow !== false,
    t?.pauseSignal === true,
    t?.autoWatchOnStart === true,
  ]);
  try {
    const cfgFile = tuningPath(process.env);
    watchFile(cfgFile, { interval: 600, persistent: false }, () => {
      try {
        const next = readTuning();
        // 设置页保存也会重写这个文件：值一样就别再走一遍（会重复打日志、白重建循环）
        if (tuningKey(next) === policyKey()) return;
        log('配置文件变了，就地生效');
        applyLiveTuning(next);
      } catch (err) {
        log(`配置文件读不动：${err?.message ?? err}`);
      }
    });
    disposers.push(() => { try { unwatchFile(cfgFile); } catch { /* 已经没了 */ } });
  } catch (err) {
    log(`监听配置文件失败：${err?.message ?? err}`);
  }

  /**
   * 悬浮窗标题栏点出来的两个动作（`window-outbox.jsonl`）。
   *
   * 用户原话：「从设置里面取消自动恢复回看的选择，直接从窗口开关」——
   * 所以「正在陪看」那格点一下是开/停陪看，「焦点·DSH」那格点一下是开/关自动续看。
   * 窗口只会往这个文件里追加一行 JSON（它已经在写 `volume` / `danmaku` 这些），
   * 这里按字节位置增量读，不重放历史动作 —— 否则一重启就自己停一次陪看。
   */
  const outboxFile = join(chatDir(), 'window-outbox.jsonl');
  let outboxPos = 0;
  let outboxInit = false;
  const outboxSeen = new Set();
  const outboxSeenPush = (key) => {
    outboxSeen.add(key);
    if (outboxSeen.size > 64) outboxSeen.delete(outboxSeen.values().next().value);
  };
  function pollWindowActions() {
    let st;
    try { st = statSync(outboxFile); } catch { return; }
    /**
     * 第一次轮询时把"历史"跳过去：`outboxPos` 从 0 起的话，插件每次重载都会把
     * 过去所有动作重放一遍（`windowOpened` 会让开关被恢复成旧记忆，很脏）。
     * 只从此刻开始读新写进来的行。
     */
    if (!outboxInit) {
      outboxInit = true;
      outboxPos = st.size;
      return;
    }
    if (st.size < outboxPos) outboxPos = 0;          // 文件被清过
    if (st.size === outboxPos) return;
    let chunk = '';
    try {
      const len = st.size - outboxPos;
      const buf = Buffer.alloc(len);
      const fd = openSync(outboxFile, 'r');
      try { readSync(fd, buf, 0, len, outboxPos); } finally { closeSync(fd); }
      chunk = buf.toString('utf8');
    } catch { return; }
    /**
     * ⚠️ **只消费到最后一个换行**，而不是把 `outboxPos` 直接推到文件末尾。
     *
     * 窗口那边是边写边 flush 的，我们 400ms 轮一次，很容易正好读到写了一半的那一行。
     * 以前这里先 `outboxPos = st.size` 再解析 —— 半行解析失败 `continue`，位置却已经
     * 越过去了：那条动作（比如"用户关了陪看"）**永远丢掉**，窗口那边的点击看起来没反应。
     *
     * 半行留到下一拍：那时它已经补全，从半行开头重新读即可（所以位置只能停在换行处）。
     */
    const cut = chunk.lastIndexOf('\n');
    if (cut < 0) return;                    // 一个完整行都还没有，等下一次
    const consumed = chunk.slice(0, cut + 1);
    outboxPos += Buffer.byteLength(consumed, 'utf8');
    for (const line of consumed.split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const type = String(msg?.type ?? '');
      if (type !== 'toggleWatch' && type !== 'toggleResume' && type !== 'focusLock'
        && type !== 'windowOpened') continue;
      const key = `${type}:${msg?.at ?? ''}`;
      if (outboxSeen.has(key)) continue;
      outboxSeenPush(key);
      try {
        if (type === 'windowOpened') {
          // 新窗口起来了 → 把二 / 三号开关恢复成上次开窗时的状态
          restoreWindowSwitches();
        } else if (type === 'toggleWatch') {
          const on = watchingNow();
          log(`悬浮窗：${on ? '停止' : '开始'}陪看`);
          if (on) stopWatching('悬浮窗标题栏');
          else void startWatching('悬浮窗标题栏');
        } else if (type === 'focusLock') {
          const want = msg?.value === true;
          const res = setWindowFocusLock(want, { log });
          if (res?.ok) log(`悬浮窗：焦点判定锁 ${want ? '开（只认总开关）' : '关（交回二号）'}`);
          // 锁上（红）= 只认总开关：如果正因焦点暂停着，就该接着陪看
          if (want && focusPaused) {
            focusPaused = null;
            if (!watchingNow()) void startWatching('三号开关');
          }
        } else {
          const want = !policy.focusResume;
          const res = writeTuning({ focusResume: want }, { log });
          if (res?.ok) {
            log(`悬浮窗：自动续看 ${want ? '开' : '关'}`);
            applyLiveTuning(readTuning());
          } else {
            log(`悬浮窗：改自动续看失败（${(res?.rejected ?? []).join('；') || '未知'}）`);
          }
        }
      } catch (err) {
        log(`悬浮窗动作 ${type} 失败：${err?.message ?? err}`);
      }
    }
  }
  {
    const timer = setInterval(pollWindowActions, 400);
    timer.unref?.();
    disposers.push(() => clearInterval(timer));
  }

  /**
   * 把"待领的说明"（挂断那一条）贴到工具结果最前面。
   *
   * 取完就没了 —— 同一句话不该每一轮都念一遍。这也解释了为什么不能写进 chat.jsonl：
   * 窗关掉之后那条流没人看，模型也拿不到（实测它继续调 watch，还说"我还在看"）。
   */
  const withPendingNote = (value) => {
    let note = null;
    try { note = runner.takeNote(); } catch { note = null; }
    if (!note || !value || typeof value !== 'object') return value;
    const text = typeof value.text === 'string' ? value.text : '';
    return { ...value, text: text ? `${note}\n\n${text}` : note };
  };

  /**
   * url → 本地缓存的下载桥。**只在 watch / start 两个入口调**（peek / seek 等跟来源无关）。
   *
   * 给 url 就先下载到 `<chatDir>/video/`（yt-dlp），再把 `path` 交给现有 file 分支 ——
   * 之后的抽帧、拼图、分档、seek 全部沿用，一行都不动。
   *
   * 三条规则都按任务书来：
   *   - url 只在 source 缺省或 "file" 时生效，screen / camera / obs 一律忽略 + 提示；
   *   - url 和 path 同时给，以 url 为准 + 提示；
   *   - 下载失败返回 `{ error }`，由调用方直接当成工具结果交出去 —— 不抛、不卡。
   *
   * @returns {Promise<{args:object, note?:string, usedUrl?:boolean, error?:{code:string, text:string}}>}
   */
  async function resolveUrlArgs(args, signal) {
    const rawUrl = args.url ? String(args.url).trim() : '';
    if (!rawUrl) return { args };
    const kind = args.source ? String(args.source).toLowerCase() : null;
    if (kind && kind !== 'file') {
      return {
        args,
        note: `这次给了 url，但 source:"${kind}" 是实况采集 —— 链接只在 source 缺省或 "file" 时才会下载。`
          + `这次忽略 url，按 ${kind} 采集。`,
      };
    }
    const r = await fetchVideo({ url: rawUrl, quality: args.quality, cacheDir: chatDir(), signal, log });
    if (!r.ok) return { error: { code: r.code, text: r.message } };
    const notes = [];
    if (args.path != null && String(args.path).trim() !== '') notes.push('同时给了 path 和 url，以 url 为准。');
    notes.push(r.fromCache
      ? `这次直接用本地缓存（${r.path}），没有重新下载。`
      : `已下载到本地：${r.path}（${(r.bytes / 1024 / 1024).toFixed(1)} MB）。`);
    const next = { ...args, path: r.path, source: 'file', url: undefined };
    if (args.region != null && String(args.region).trim() !== '') {
      delete next.region;
      notes.push('给了 region，但下载回放的是本地文件，region 不适用（屏幕采集才有区域）。');
    }
    return { args: next, note: notes.join(' '), usedUrl: true };
  }

  const toolObj = {
    ...seeNowToolSpec(),
    async execute(args = {}, run = {}) {
      // 任何一次调用都算"接住了上一条叫醒"：循环据此避免在模型没回应时继续投递唤醒
      // （以前的毛病：一轮跑几十秒，叫醒照发不误，用户屏幕上积一串「有新画面了」）。
      loop?.noteActivity?.();
      // 第二个参数是宿主的 `ToolRunContext`：`signal` 是"这一轮被取消了"的唯一通知。
      // 它只交给**阻塞等待**（watch）；常驻循环不挂它，理由见 ensureLoop。
      const out = await toolObj.route(args, run);
      // 切模式那句话只带一次：模型要立刻知道"从现在起一张图一个画面"，
      // 但下一轮还念一遍就变成噪音了。
      const noted = pendingModeNote && out && typeof out.text === 'string'
        ? { ...out, text: `${pendingModeNote}\n\n${out.text}` }
        : out;
      pendingModeNote = '';
      return toLosslessJson(withPendingNote(noted));
    },

    async route(args = {}, run = {}) {
      const action = String(args.action ?? 'watch').toLowerCase();

      // **每次调用都检查一遍声音**：改了 voice.json / tts.json，下一句就生效，不用重启宿主。
      // 代价是一次 stat —— 挂载状态没变时 ensure 立刻返回，不会重复 import。
      await ensureConfiguredVoice({ log }).catch(() => { /* 声音永远不该挡住看屏幕 */ });

      // **`say` 的唯一入口**，在**任何采集动作之前**处理。
      //
      // 两件事必须同时发生，所以只能有一处：
      //   ① 写盘 + 发声（`appendSpoken`）—— 窗口里有字、嘴里有声，缺一个就是 bug；
      //   ② 撤掉"你还没回她"的待回执 —— 说了话就等于回了。
      //
      // 以前这两件事写在 `runner.watch()` 里，于是 `peek` 带 `say` 时既不发声也不清待回执
      // （实测：peek 回了话，下一轮还在念"你还没回"）。放在这里所有 action 都覆盖到。
      const said = args.say ? String(args.say).trim().slice(0, 800) : null;
      if (said) {
        try { appendSpoken('assistant', said); } catch { /* 写不进不影响看屏幕 */ }
        clearInterjected();
      }

      /**
       * `help` —— 手册按需取。
       *
       * 工具契约是**每一轮都要重发**的常驻文案，所以"为什么/多少 token/实测数字"这类
       * 一辈子问不了一次的东西搬到了 `help.js`，模型不确定时自己调一次。
       * 放在 `say` 之后、采集之前：`help` 不该启动采集，也别让用户看不见它附带的那句话。
       */
      if (action === 'help') {
        return { text: SEE_NOW_HELP, meta: { action } };
      }

      /**
       * 模式开关（粘性）。
       *
       * 变了就必须**把管线拆掉重开**：`maxFrames` / `strategy` 是建管线时定死的参数，
       * 运行中改不了。同时把循环也重建一次 —— 唤醒间隔跟着模式走
       * （逐帧 4 秒 / 常规 8 秒），不重建的话切过去还是旧节奏。
       */
      let modeNote = '';
      if (typeof args.scene === 'boolean' && args.scene !== sceneMode) {
        sceneMode = args.scene;
        try { runner.stop(); } catch { /* 没在跑 */ }
        stopLoop('换模式');
        loopScene = null;
        modeNote = sceneMode
          ? '已切到**逐帧模式**：每换一次场景给你一张满幅图（一张图 = 一个画面）。'
            + '只在演示/逐场景播报时用；说完话接着调 watch，换场景时我会叫你。'
          : '已切回**常规模式**：一张图装几帧、攒够才发。';
        log(modeNote.replace(/\*\*/g, ''));
        pendingModeNote = modeNote;
      }

      /**
       * 节奏（粘性）。**这是"太密了 / 省点钱"唯一真正生效的入口。**
       *
       * 光靠模型在 `say` 里答应没用 —— 出图频率和唤醒间隔都是插件参数，
       * 不改参数就是不改行为。所以听到"慢一点 / 省点钱"就传 `pace:"calm"`。
       */
      let wantPace = args.pace ? String(args.pace).toLowerCase() : null;
      // 旧名兼容：`action` 曾短暂用过，收到就走新档
      if (wantPace === 'action') wantPace = 'game-economic';
      /**
       * 档位：模型传 `tier` 才会走到这里，没传就保持当前值。
       * 不在 schema 里教它什么时候用 —— 见 `tool-spec.js` 那段注释。
       */
      const wantTier = args.tier ? String(args.tier).toLowerCase() : null;
      /**
       * 模型只能选这四档。**`custom` 故意不给它** —— 那是一张八项的表，
       * 模型填不准（它看不到当前档位分布），传了 `custom` 却没有表等于什么都不改。
       */
      if (wantTier && TIER_MODES.includes(wantTier) && wantTier !== tierMode) {
        tierMode = wantTier;
        log(`档位改成 ${wantTier}`);
      }

      if (wantPace && PACES[wantPace] && wantPace !== paceMode) {
        paceMode = wantPace;
        try { runner.stop(); } catch { /* 没在跑 */ }
        stopLoop('换节奏');
        loopScene = null;
        const t = {
          calm: '已切到**省电节奏**：20 分以上才算换画面，最多 30 秒叫你一次。',
          normal: '已切回**默认节奏**：12 分算换画面，最多 15 秒叫一次。',
          dense: '已切到**灵敏节奏**：7 分就算换画面，最多 8 秒叫一次（费钱，只在演示/逐帧时用）。',
          'game-economic': '已切到**动作节奏**：80 分以上才算换画面，出帧按"攒够 30 秒运动量"算，'
            + '最多 20 秒叫一次，每张图最多 8 帧（全屏游戏/高速画面用，信息量比 normal 少）。',
        }[wantPace];
        pendingModeNote = [t, pendingModeNote].filter(Boolean).join('\n\n');
        log(t.replace(/\*\*/g, ''));
      }

      if (action === 'watch') {
        // **循环的 owner 必须在等待开始前锁定**。`runner.watch()` 会阻塞 15~40 秒，
        // 这期间任何会话的 `session/event` 都会改写 `lastSessionId`；等它返回再
        // `ensureLoop()` 现取，就会把后续唤醒投到"等待期间最后说话的那个会话"去
        // （issue #1 的复现：watch 在 A 会话发起，结束后循环绑到了 B）。
        //
        // 绑了会话就用绑的那个：用户选了"A 窗口跟我聊"之后，在 B 里调 watch
        // 也不该把陪看的所有权搬过去。
        const ownerAtStart = talkTarget();
        /**
         * 链接下载桥（`url`）。必须在 `srcOf` 之前处理：
         * 下载成功就把 path 交进 file 分支，抽帧/拼图/seek 全沿用；
         * 下载失败直接当成这一轮的结果交出去 —— 不抛异常、不卡住。
         */
        const urlRes = await resolveUrlArgs(args, run?.signal);
        if (urlRes.error) {
          return { text: urlRes.error.text, meta: { ok: false, reason: urlRes.error.code } };
        }
        const args2 = urlRes.args;
        if (urlRes.note) pendingModeNote = [urlRes.note, pendingModeNote].filter(Boolean).join('\n\n');
        /**
         * region 的三个入口，优先级从高到低：
         *   1. `region:"off"` —— 取消（存的那块一起删掉）
         *   2. `region:"x,y,w,h"` —— 这一次用这块（`srcOf` 负责校验和报错）
         *   3. 都没传 —— 用用户上次框好的那块（`~/.dsh/see-now/region.json`）
         *
         * 第 3 条是这次的重点：**模型不该被要求记住四个数字**。用户框一次，之后
         * 每轮 `watch` 自动就是那块。
         */
        const rawRegion = typeof args2.region === 'string' ? args2.region.trim() : '';
        const regionOff = /^(off|none|clear)$/i.test(rawRegion);
        const built = srcOf(regionOff ? { ...args2, region: undefined } : args2);
        if (built.error) return { text: built.error, meta: { ok: false, reason: 'bad-region' } };
        const src = built.src;
        const stickyRegion = regionOff ? null : (rawRegion ? undefined : loadRegion());
        if (regionOff) {
          clearRegion();
        } else if (rawRegion) {
          // 显式传的 region 也要落盘，否则下一轮 watch 不带 region 就回到整屏
          const parsed = parseRegion(rawRegion);
          if (parsed) {
            try { saveRegion(parsed); } catch { /* 写不了盘不影响这一次 */ }
          }
        }
        // 变了一次说一次：模型要知道自己现在只看这一块，也得知道已经回到整屏
        const regionKey = regionText(stickyRegion ?? src?.region ?? null);
        if (regionKey !== lastRegionKey) {
          lastRegionKey = regionKey;
          pendingModeNote = [
            regionKey
              ? `现在只抓屏幕上的 **${regionKey}** 这一块`
                + `${process.platform === 'linux' ? '（采集流坐标）' : '（屏幕物理像素）'}`
                + '—— 画面之外的东西你看不到，'
                + '也不要假设整屏发生过什么。'
              : '已经回到**整屏**，不再只抓那一块。',
            pendingModeNote,
          ].filter(Boolean).join('\n\n');
        }
        // **封顶必须小于宿主给这个工具的 timeoutMs**（见 tool-spec）：工具自己挂得比
        // 宿主的死线还久，到点就不是"返回一张图"，而是整条调用被 abort（还会顺带 abort signal）。
        const seconds = Math.min(
          Number(args.seconds) > 0 ? Number(args.seconds) : DEFAULT_BLOCK_SEC,
          MAX_BLOCK_SEC,
        );
        const requestedMinFrames = Number(args.minFrames) > 0 ? Number(args.minFrames) : 1;
        // **逐帧模式和 minFrames 互斥**：逐帧一张图就 1 帧，`minFrames > 1` 永远等不满，
        // 会一路等到超时再报"画面没变"——那是假故障。让 minFrames 让路（它只是
        // "别给我太碎的图"，而逐帧本来就要碎），并把这句说出去，别让人以为设了 5 就真有 5。
        const minFrames = sceneMode ? 1 : requestedMinFrames;
        if (sceneMode && requestedMinFrames > 1) {
          pendingModeNote = [
            `逐帧模式下每张图只有 1 帧，\`minFrames: ${requestedMinFrames}\` 这条路上不生效（已按 1 处理）。`
            + '要按帧数攒图，先 `see_now({scene:false})`。',
            pendingModeNote,
          ].filter(Boolean).join('\n\n');
        }
        if (src?.kind) lastSrcKind = src.kind;
        const r = await runner.watch({
          seconds,
          minFrames,
          src,
          // "用户亲口说要看看什么" = 传了 source/path/url。**不能用 `src.kind` 反推**：
          // 只传 region 时 `srcOf()` 也会补出 `{kind:'screen'}`，那只是换个取景框，
          // 不该把"关窗后别再自动弹出来"那道闸打开。
          explicitSource: Boolean(args2.source || args2.path || args2.url),
          // 存下来的那块（undefined = 这次没提，保持原样；null = 显式取消）
          region: regionOff ? null : stickyRegion,
          // 走了 url 下载时，quality 只负责"下载哪一档"（medium 这类值不在采集清晰度表里，
          // 传过去会静默落到 low）—— 所以 url 生效时这里显式传 null，保持当前采集档位。
          quality: urlRes.usedUrl ? null : (args2.quality ? String(args2.quality).toLowerCase() : null),
          // 逐帧模式：一张图一帧 + 档位固定 1（铺满）；常规按节奏定切点门槛。
          // 参数变了 runner 会自己重开管线。
          opts: {
            ...(sceneMode ? SCENE_OPTS : {}),
            // 档位自带的管线覆盖（`action` 用：积分阈值、每张帧数、兜底间隔…）。
            // 逐帧模式不吃这套 —— 它自己已经定死了 maxFrames/strategy。
            ...(sceneMode ? {} : (PACES[paceMode].pipeline ?? {})),
            /**
             * 每帧多大。`tierMode` 变了签名就变，runner 会自己重开管线（约 0.5 秒），
             * 不用在这里手动 stop。逐帧模式由 `SCENE_OPTS` 钉成 `single`，这里跳过。
             */
            ...(sceneMode ? {} : { strategy: tierMode }),
            // 设置页选了「自定义」时把那张表带上；模型改过档位后就不再是 custom 了
            ...(sceneMode || tierMode !== 'custom' ? {} : { tierMap: tuning.tierMap }),
            // **文件回放（看视频）走视频最优门槛**：实测 27 段短视频上，cutAbs 7 的切点 F1 是 56.8%，
            // 默认 12 只有 51.9%（12fps 采样本来就会吃掉一部分快切）。屏幕采集不受影响。
            // 用户显式传了 pace 就尊重用户。
            cutAbs: (sceneMode
              ? PACES.dense
              : (lastSrcKind === 'file' && !wantPace && paceMode === 'normal' ? PACES.dense : PACES[paceMode])).cutAbs,
          },
          signal: run?.signal ?? null,
        });
        if (!r.ok) {
          // 用户关过窗：**只有他重新要求看，才允许再开**。这一条以前只靠工具描述
          // 里的一句"别再调了"，模型不照做就会把窗重新弹出来。
          if (r.reason === 'hung-up') {
            return {
              text: '用户已经关掉了悬浮窗，这一轮看屏幕结束了。\n'
                + '**不要再调 `see_now`**。等用户明确说要看（或者重新打开窗口）再开始。',
              meta: { ok: false, reason: 'hung-up' },
            };
          }
          // 文件回放放完了：不能自动从头重播，必须显式再传一次来源。
          if (r.reason === 'file-ended') {
            return {
              text: `这个文件已经放完了（${r.path ?? ''}）。\n`
                + '**不会自动重播**。要再看一遍就显式传 `source:"file"` + `path`，'
                + '要接着看屏幕就传 `source:"screen"`。',
              meta: { ok: false, reason: 'file-ended', path: r.path ?? null },
            };
          }
          if (r.reason === 'cancelled') {
            return {
              text: '这一轮被取消了（用户按了停止，或者调用超时），等待已经结束。\n'
                + '他想接着看时说一声，再调 `see_now({action:"watch"})`。',
              meta: { ok: false, reason: 'cancelled', waited: +r.waited.toFixed(1) },
            };
          }
          if (r.userText) {
            return {
              text: `用户刚说话：「${r.userText}」——但这一刻还没收到画面（刚开或刚发完）。\n`
                + '先回答他，需要看图就再调一次 `see_now`。',
              meta: { ok: false, reason: r.reason, userText: r.userText, waited: +r.waited.toFixed(1) },
            };
          }
          return {
            text: r.reason === 'no-change'
              ? `看了 ${r.waited.toFixed(0)} 秒，画面基本没变（不够 ${minFrames} 帧就不发）。`
                + '\n再等一会儿，或者直接问用户想让你看什么。'
              : `没看成（${r.reason}）${r.error ? `：${r.error}` : ''}。`,
            meta: { ok: false, reason: r.reason, waited: +r.waited.toFixed(1) },
          };
        }
        // **拿到第一张图之后就把钟起起来** —— 这是"看一眼就完"和"一直看下去"的分界线。
        // 之后每攒够一张，循环会自己叫醒你，不用你再调。
        const lp = ensureLoop(ownerAtStart);
        const out = await attachAndReturn(ctx, r.sheets, {
          waited: r.waited, partial: r.partial, quality: r.quality,
          userText: r.userText ?? null,
          say: said,
          looping: Boolean(lp) && !lp.stopped(),
          loopWakes: lp ? lp.state().wakes : 0,
        });
        /**
         * **窗被藏起来时必须当面说清**，否则就是"你说'眼睛开上了'，屏幕上什么都没有"。
         * 只在藏着的时候加这一句（正常情况不加噪音），并给出唯一能用的那条指令。
         */
        if (r.windowOpen === false) {
          // 窗压根没开起来（最常见：没有带 tkinter 的 python）。这时候 `say` 同样是石沉大海，
          // 但**不能**叫模型去 show —— show 改的是配置，解决不了"进程起不来"。
          const why = runner.status().window?.reason;
          return {
            ...out,
            text: `${out.text}\n\n**悬浮窗没开起来${why ? `（${why}）` : ''}** —— 用户看不到也听不到你的 \`say\`。`
              + '\n别说"我在看着你"这类话；先在正文里告诉他这个情况（正文能到，`say` 到不了）。',
            meta: { ...out.meta, windowOpen: false },
          };
        }
        /**
         * 判断"用户是不是真的看不见"，**以窗口自报的可见性为准**。
         *
         * `windowHidden()` 只读配置文件（意图）；这里要回答的是事实。
         * 实测踩过：配置写着 `hidden:true`，窗口其实好好的（残留状态已被自愈写回，
         * 只是这一拍还没刷盘）—— 照着配置提示"用户看不见"就是纯噪音；
         * 反过来配置 `hidden:false`、Python 侧 withdraw 了，提示就该出现。
         */
        const wr = windowReport();
        const invisible = wr.visible === null ? windowHidden() : !wr.visible;
        if (!invisible) return out;
        return {
          ...out,
          text: `${out.text}\n\n${windowLine(wr)}\n`
            + '**用户看不到你的 `say`** —— 窗是藏起来的。'
            + '要他看见就调 `see_now({action:"window", show:true})`。',
          meta: { ...out.meta, windowHidden: true, windowState: wr.state },
        };
      }

      if (action === 'peek') {
        const s = runner.peek();
        const st = runner.status();
        // 走 peek 路线的会话也要有循环：不然模型摘完这一张就结束，没人再叫它。
        // **但采集都停了就别起** —— 起一个下一拍就自杀的钟只是噪音。
        // 注意 `s` 现在是**数组**：空数组是 truthy，不能直接 `!s`
        const lp = (s?.length || st.running || st.pending) ? ensureLoop() : null;
        if (!s?.length) {
          return {
            text: '手上还没有画面（刚开或刚发完，下一张还在攒）。\n'
              + `循环${!lp || lp.stopped() ? '没在跑' : '在跑'} —— 攒够我会叫你；要看此刻可以调 \`see_now({action:"watch"})\`。`,
            meta: { ok: false, reason: 'no-sheet', loop: lp?.state() ?? null },
          };
        }
        return await attachAndReturn(ctx, s, { looping: Boolean(lp) && !lp.stopped() });
      }

      if (action === 'pause' || action === 'resume' || action === 'seek' || action === 'configure') {
        // 本地视频回放控制。屏幕和摄像头源会被明确拒绝（不假装成功）。
        const r = action === 'seek' ? await runner.seek(args.position)
          : action === 'configure' ? await runner.configure({ quality: args.quality })
            : await runner[action]();
        return {
          text: r.ok ? (r.text ?? `文件操作完成：${action}`) : (r.text ?? `文件操作未完成：${r.reason}`),
          meta: { ok: r.ok !== false, reason: r.reason ?? null, playback: r.playback ?? null },
        };
      }

      if (action === 'start') {
        // 和 watch 同一个下载桥：给了 url 就先下到本地，再按 file 起采集。
        const urlRes = await resolveUrlArgs(args, run?.signal);
        if (urlRes.error) {
          return { text: urlRes.error.text, meta: { ok: false, reason: urlRes.error.code } };
        }
        const a2 = urlRes.args;
        const built = srcOf(a2);
        if (built.error) return { text: built.error, meta: { ok: false, reason: 'bad-region' } };
        const r = await runner.start({ src: built.src ?? { kind: 'screen' } });
        return {
          text: (r.already ? '已经在看了。'
            : `开始看 ${r.source.kind}（引擎 ${r.engine}）${r.warning ? `。⚠️ ${r.warning}` : '。'}`)
            + (urlRes.note ? `\n${urlRes.note}` : ''),
          meta: r,
        };
      }

      if (action === 'stop') {
        stopLoop('手动 stop');
        runner.stop();
        return { text: '停了。窗口还开着，想再看得重新调 watch。', meta: { ok: true } };
      }

      /**
       * 悬浮窗的显示 / 隐藏 / 状态。
       *
       * **这是"窗在但看不见"的唯一出口。** 以前没有它：模型发现窗被藏起来了，
       * 只能去读 `~/.dsh/watch-window.json`，又没有写权限，于是答
       * "我这边只有读权限，发不了「显示」指令"（2026-11-03 社区反馈）。
       *
       * 改的是窗口进程每 250ms 轮询的那份文件，所以**不用重启窗口**，一拍就生效。
       */
      if (action === 'window') {
        const wants = typeof args.show === 'boolean' ? args.show : null;
        const wantsDanmaku = typeof args.danmaku === 'boolean' ? args.danmaku : null;
        let changed = null;
        let dm = null;
        if (wants !== null) {
          // `show` 和 `hidden` 方向相反，换算只在 hiddenForShow 一处
          changed = setWindowHidden(hiddenForShow(wants), { log });
          log(`悬浮窗${wants ? '显示' : '最小化'}${changed.changed ? '' : '（本来就是）'}`);
        }
        if (wantsDanmaku !== null) {
          dm = setWindowDanmaku(wantsDanmaku, { log });
          log(`弹幕${wantsDanmaku ? '开' : '关'}${dm.changed ? '' : '（本来就是）'}`);
        }
        const r = windowReport();
        /**
         * 刚写完配置的这一拍，窗口那边还没跟上：`_sync_visible()` 每 250ms 读一次，
         * 心跳每秒才写一次。所以 `visible` 可能还是上一秒的值。
         * 不区分的话，`show:true` 刚成功就会输出"已让悬浮窗显示出来 \n 窗口：**藏起来的**"，
         * 自相矛盾，还会顺带触发下面那条"用户现在看不到任何东西"的警告。
         */
        const lagging = Boolean(changed?.changed) && r.hidden !== (wants === true);
        const head = wants === null
          ? '悬浮窗现在是这样：'
          : wants
            ? (changed?.error ? `没改成显示（${changed.error}），现状：` : '已让悬浮窗显示出来。')
            : (changed?.error ? `没改成隐藏（${changed.error}），现状：` : '已把悬浮窗藏起来（采集照常，只是看不见）。');
        return {
          text: `${head}\n${windowLine(r)}`
            + (dm ? `\n弹幕已${dm.danmaku ? '打开（台词会从屏幕顶部飘过）' : '关掉'}。` : '')
            + (lagging ? '\n（这一行还是上一秒的状态，最多 1 秒后刷新。）' : '')
            + (r.alive ? '' : '\n窗没开着 —— 下一次 `watch` 会重新开一个。')
            + (r.alive && r.hidden && wants !== false && !lagging
              ? '\n**用户现在看不到任何东西**：要么 `see_now({action:"window", show:true})`，'
                + (dm?.danmaku ? '要么就靠弹幕说话（弹幕开着）。' : '要么就别再用 `say` 说话，等他主动问。')
              : ''),
          meta: {
            ok: changed ? !changed.error : (dm ? !dm.error : true),
            window: r,
            changed: changed?.changed ?? false,
            danmaku: dm?.danmaku ?? readWindowDanmaku(),
          },
        };
      }

      /**
       * 框一块屏幕给它看（`action:"region"`）。
       *
       * 为什么要有这条：`region:"x,y,w,h"` 是 PR #9 加的，但**谁来量这四个数**是
       * 没人解决的问题 —— 让用户去截图软件里读像素不现实。这里起一个全屏取框窗
       * （`pick_region.py`，和悬浮窗共用同一个带 tkinter 的 python），拖一下松手，
       * 坐标直接落盘，之后 `watch` 默认就用它。
       *
       * 会**阻塞到用户框完**（最长 3 分钟）。调用前最好先 `say` 一句"屏幕上会变暗，
       * 拖个框就行"，否则用户不知道那块黑罩子是哪来的。
       */
      if (action === 'region') {
        if (/^(off|none|clear)$/i.test(String(args.region ?? '').trim())) {
          const had = loadRegion();
          clearRegion();
          lastRegionKey = null;
          return {
            text: had ? `已取消区域（原来是 ${regionText(had)}），下一次 watch 抓整屏。` : '本来就没设区域，现在还是整屏。',
            meta: { ok: true, region: null },
          };
        }
        const r = await pickRegion({ log });
        if (!r.ok) {
          const why = {
            cancelled: '用户取消了框选（Esc / 右键），什么都没改。',
            timeout: '等了三分钟没框完，取框窗已经收掉了。',
            'no-python': `找不到能跑取框窗的 python（要带 tkinter）：${r.detail ?? ''}`,
            'no-script': `取框脚本不见了：${r.detail ?? ''}`,
            failed: `取框失败：${r.detail ?? ''}`,
          }[r.reason] ?? `取框没成（${r.reason}）。`;
          return { text: why, meta: { ok: false, reason: r.reason, detail: r.detail ?? null } };
        }
        const t = regionText(r.region);
        lastRegionKey = t;
        pendingModeNote = `用户刚框好一块：**${t}**（屏幕物理像素）。现在只看这一块。`;
        log(`区域已选：${t}`);
        return {
          text: `框好了：**${t}**（${r.region.w}×${r.region.h}，屏幕物理像素）。\n`
            + '从现在起 `watch` 默认只抓这块，不用再传 `region`。\n\n'
            + '三条你要知道的（也是该告诉用户的）：\n'
            + '- 抓的是**屏幕上正在显示的像素**：这块被别的窗口挡住，你看到的就是挡住它的那个窗口。\n'
            + '- 没接 OBS，抓不到后台窗口、最小化的窗口。\n'
            + '- 只在主屏有效；框到主屏外面会被拒绝（gdigrab 不接受负偏移）。\n'
            + '换一块：再调一次 `see_now({action:"region"})`；不要了：`see_now({action:"region", region:"off"})`。',
          meta: { ok: true, region: r.region },
        };
      }

      if (action === 'offload') {
        const askedTrigger = args.trigger === undefined ? tuning.imageTrigger : Number(args.trigger);
        const askedKeep = args.keep === undefined ? tuning.imageKeep : Number(args.keep);
        const trigger = Number.isFinite(askedTrigger) && askedTrigger >= 0 ? Math.floor(askedTrigger) : tuning.imageTrigger;
        const keep = Number.isFinite(askedKeep) && askedKeep >= 0 ? Math.floor(askedKeep) : tuning.imageKeep;
        const r = await runOffload({ trigger, keep });
        return { text: r.text, meta: r.meta };
      }

      if (action === 'status') {
        const s = runner.status();
        const voice = voiceState();
        const lp = loop?.state() ?? null;
        /**
         * 图库水位：**只报"本次采集"出了几张**，不假装知道整个会话。
         *
         * 说清楚为什么只能这样：一张图落在宿主附件库里，被会话历史的 attachmentId
         * 引用着，谁引用谁留存；宿主不会回收，插件也读不到别人的会话日志。
         * 所以这里给的是"这一趟看了多少"，换算按 798×450 的实测口径
         * （222 token / 约 130 KB 一张），只当量级参考，别当账单。
         */
        const sheets = s.stats?.sheets ?? 0;
        const estKTok = Math.round(sheets * 222 / 1000);
        const estMB = Math.round(sheets * 130 / 1024);
        return {
          text: (s.running
            ? `在看 ${s.source?.kind}${s.source?.engine === 'portal' ? '/portal' : ''} @${s.size?.[0]}×${s.size?.[1]}（${s.quality}，${s.since}s，收到 ${s.frames} 帧，留帧 ${s.stats?.kept ?? 0}，出图 ${s.stats?.sheets ?? 0}）`
              + `${s.lastError ? `\n⚠ ${s.lastError}` : ''}`
            : `没在采集（${s.idleSec}s 前停的）${s.lastError ? `\n⚠ ${s.lastError}` : ''}`)
            // 循环状态单独一行：**"模型答一句就停"时第一个要看的就是它**
            + `\n循环：${loopLine(lp)}`
            // 队列：手上有没有攒着没取走的图 —— `pending` 一直是 1 时模型不会收到新图，只会一直被叫
            + `\n队列：${s.pending ? `有 ${s.pending} 张没取走（出图序号 ${s.sheets}）` : '空'}`
            // 图库水位：**同一个会话里反复看，历史里的图只会累积**（宿主不回收、压缩也不释放磁盘）
            + (sheets > 0
              ? `\n图库：本次采集出 ${sheets} 张（≈${estKTok}k token、${estMB} MB）`
                + (sheets >= 200
                  ? `\n  ↳ 已经不少了：这些图都留在本会话历史里，每轮请求都会重发。`
                    + '再往下看，重算会越来越贵 —— 建议新开一个会话继续。'
                  : '')
              : '')
            // 预留：**"叫醒了却没图"这两个数一起看** —— `pending 空 + 预留有` 是正常的
            // （图已经叫醒、等人来 peek）；两个都空而模型说没图，才是真的空手
            + `${s.reserved ? ` · 预留 1 张（${s.reserved.ageSec}s 前叫醒的，等 peek 取）` : ''}`
            + `${s.takes?.peekEmpty ? ` · peek 空过 ${s.takes.peekEmpty}/${s.takes.peek} 次` : ''}`
            // 窗口：**"它在看但我什么都没看到"时第一个要看的就是这一行**
            + `\n${windowLine()}`
            + (s.window?.ok === false && s.window?.reason ? `\n  ↳ 开窗失败：${s.window.reason}` : '')
            // 指示框：用户屏幕上的"有人在看"。采集时被裁掉，所以模型看到的结果里没有它
            + (s.indicator?.running
              ? `\n指示框：在（逻辑 ${s.indicator.logicalWidth}×${s.indicator.logicalHeight}；`
                + '采集流里不含它，所以不裁）'
              : '')
            // 模式：逐帧时一张图只有一帧、铺满；常规是多帧拼格
            + `\n模式：${sceneMode ? '逐帧（一张图 = 一个场景，铺满）' : '常规（多帧拼一张）'}`
            + ` · 节奏：${sceneMode ? 'dense（跟逐帧走）' : paceMode}`
            + `（切点门槛 ${(sceneMode ? PACES.dense : PACES[paceMode]).cutAbs}，`
            + `最多 ${sceneMode ? 4 : PACES[paceMode].wakeGapSec} 秒叫一次）`
            // 门槛是常数，归一之后它的含义变了（"参考亮度下"的 12）—— 不写出来会对不上账
            + (tuning.scoreNormalize ? ' · 亮度归一开（暗场/黑边已补偿）' : ' · 亮度归一关')
            // 超省模式是"一次交几张"，和"多久叫一次"是两件事，单独说
            + (tuning.wakeBatch > 1 ? `\n超省模式：攒够 ${tuning.wakeBatch} 张才交（一轮看完，省上下文重算）` : '')
            /**
             * 档位分布：**"格子怎么变了"有两级原因**（节奏 → 密度 → 档位，再由映射偏移），
             * 只报"节奏"看不清。这一行能分出"帧太少所以格子大"和"映射被改了"。
             */
            + tierLine(s.stats?.tierHist, {
              style: tierMode, mode: tuning.tierMode, curve: tuning.tierCurve,
            })
            // 收工线：用户改过 see-now.json 时要能看出来，否则"怎么陪我一会儿就停了"查不到
            + `\n收工线：连续 ${tuning.maxAutonomousWakes} 次叫醒没人理`
            + ` · ${tuning.idleStopMin > 0 ? `没开窗时 ${tuning.idleStopMin} 分钟没说话` : '空闲线已关闭'}`
            + `${tuning.path && tuning.maxAutonomousWakes === 8 && tuning.idleStopMin === 3 ? '（默认）' : `（${tuning.path}）`}`
            // 区域：只看一小块时，模型得知道自己看到的不是整屏
            + `\n区域：${regionText(s.lastSource?.region ?? loadRegion()) ?? '整屏'}`
            // 采集流的坐标系：Linux 上 region 的 x,y,w,h 就是按这个尺寸量的
            + (s.stream?.width ? `（采集流 ${s.stream.width}×${s.stream.height}，region 坐标用这个空间）` : '')
            // 声音单独一行：听不到声音时第一个要看的就是这里
            + `\n声音：${voice.speakers > 0
              ? `已接上 ${voice.adapters.join(', ') || '适配器'}（${voice.speakers} 个会出声的订阅者）`
              : voice.configured
                ? `配了 ${voice.configured} 但没挂上（${voice.reason ?? '原因未知'}）`
                : '没配 —— 写 ~/.dsh/voice.json 的 {"adapter":"…"} 才有声音'}`
            // 听声音（视频里的台词）：**"它不知道台词"时第一个要看的就是这一行**
            + `\n听声音：${listenLine(s.listen)}`
            // 宿主 cookie 拥挤度：只快满了才出现（满了之后插件根本起不来，提醒不到）
            + cookieWarnLine(),
          meta: { ...s, voice, loop: lp, window: windowReport() },
        };
      }

      return { text: `未知 action: ${action}（可用 watch / peek / start / stop / status / window / region / offload / help）`, meta: { action } };
    },
  };

  /**
   * 注册工具。**单独兜住"已经被别人注册过"**：装了两次（profile 的 bundles 里有一份、
   * 又在 patch 里插了一份）时这里会抛 `tool "see_now" is already registered`。
   * 以前这句会一路冒到 `apply()` 的兜底里，把整个插件判死 —— 连窗和循环都不起。
   * 现在只记一行，让已经注册的那一份继续工作。
   */
  try {
    disposers.push(ctx.tools.register(defineTool(toolObj)));
    // 注册成功要留一行：出问题时"加载失败"（有 plugin-error.log）和"装了两份、被去重"
    // 是两回事，没有这行只能靠猜。
    log(`已注册工具 ${TOOL_NAME}（v${VERSION}）`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/already registered/i.test(msg)) throw e;
    /**
     * 装了两份：另一份已经在供货。**这一份必须整个退掉** —— 只是"不注册工具"的话，
     * 它的 runner / 常驻循环 / 窗口照样起来，于是同一个模型被两套循环各叫一次。
     */
    log(`工具 ${TOOL_NAME} 已经注册过了（${msg}）—— 这一份直接退出，避免两套循环同时叫醒模型`);
    for (const d of disposers.reverse()) { try { d?.(); } catch { /* 收不干净也不能再炸 */ } }
    return () => {};
  }

  return () => { for (const d of disposers.reverse()) d?.(); };
}
