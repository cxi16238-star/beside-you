/**
 * 设置页背后的三条路由，全在 `/api/see-now/` 下。
 *
 * | 方法 | 路径 | 作用 |
 * |---|---|---|
 * | GET  | `/status` | 当前生效的值、默认值、文件路径、校验警告、可选会话、伴生进程状态 |
 * | POST | `/config` | 提交要改的键；校验通过才落盘（`see-now.json`） |
 * | POST | `/local`  | 改转写服务的地址与凭据（`asr.json`） |
 * | GET/POST | `/window` | 看/改悬浮窗外观（`watch-window.json` 的 `glass`） |
 *
 * ## 为什么 `/status` 里要多带会话列表和伴生进程状态
 *
 * 「小窗绑哪个会话」这个下拉框**必须在打开设置页那一刻就有选项**：空着的话用户
 * 只能手打一个 id，而那正是最不可能被填对的字段。会话是活数据（会开会关），
 * 落盘没有意义，所以每次 GET 现取。
 *
 * 伴生进程（全局快捷键 / 前台窗口）同理：它可能因为"没有 Python"而根本没起来，
 * 这件事必须让用户**在设置页里当场看见**，而不是"设了快捷键，按下去没反应"。
 * 这一条是 `createSettingsApi` 收 `companionStatus` 回调的唯一理由。
 *
 * ## 为什么 `onApplied` 是"写完才回调"
 *
 * 快捷键和焦点开关都是**当前进程里的行为**，不是下次启动才读的文件。写完立刻
 * 把新值交给插件（`onApplied`）才能做到"保存之后马上生效"；回调抛异常也**不能**
 * 影响回包 —— 用户在等的是"存没存上"，不是"热重配成没成"。
 *
 * ## 为什么这么几条
 *
 * 这套配置没有长任务 —— 没有安装、没有下载、没有子进程。读一次文件、写一次文件
 * 都是毫秒级，用不着 ui-locate 那种「POST 起任务 + GET 轮询进度」的形状。
 *
 * ## 为什么拒写也回 200
 *
 * "值越界"是业务上的拒绝，不是请求格式错误：请求本身完全合法，用户的心智模型是
 * 「它没接受我的数」，而不是「网络/接口坏了」。前端拿到 `{ok:false, rejected:[…]}`
 * 直接把原因显示在输入框下面，不用先判 HTTP 状态再解析 body。
 *
 * @module src/settings-api.mjs
 */

import { rejectionFor } from './settings-trust.js';
import { asrPath, readAsrConfig, writeAsrConfig } from './asr-store.mjs';
import { readWindowStyle, setWindowStyle, setWindowHidden, setWindowMini, setWindowDanmaku, setWindowOpacity, setWindowUi } from './window.js';
import {
  readTuning,
  writeTuning,
  tuningPath,
  TUNING_DEFAULTS,
  LISTEN_DEFAULTS,
  PACES_KEYS,
  WRITABLE_KEYS,
  WRITABLE_LISTEN_KEYS,
} from './tuning.js';

/** 与 `client.js` 里的 `API` 常量必须一致。 */
export const ROUTE_PREFIX = '/api/see-now';

/** 面板提交的 JSON 不该有大请求体；给足富余但仍设上限。 */
const BODY_LIMIT = 32 << 10;

/** 给前端的默认值。派生的 `idleStopMs` 也补上，省得前端自己乘 60000。 */
function defaultsPayload() {
  return {
    ...TUNING_DEFAULTS,
    idleStopMs: TUNING_DEFAULTS.idleStopMin * 60 * 1000,
    listen: { ...LISTEN_DEFAULTS },
  };
}

/** `baseUrl` → `DSH_ASR_BASE_URL`。给面板标出"这个值正被环境变量盖着"。 */
function envKeyOf(name) {
  return `DSH_ASR_${name.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`;
}

/**
 * `asr.json` 的现状 —— 面板上「转写服务」到底指哪个文件、里面写了什么。
 *
 * 文件在 `$DSH_HOME/asr.json`，与 video-storyboard 共用一份。两个插件都读它，
 * 所以面板既能看也能改（只动认得的键，别的键原样留着）。
 */
function localPayload() {
  const info = readAsrConfig(asrPath(tuningPath()));
  // 环境变量优先于文件。面板要能把"你改的那个文件没生效"说出来。
  const envKeys = ['api', 'baseUrl', 'key', 'model', 'language'].filter(
    (k) => Boolean(process.env[envKeyOf(k)]),
  );
  return { ...info, envOverrides: envKeys.length > 0, envKeys };
}

/** 把 `readTuning()` 的结果拆成「值」与「警告」两半 —— 前端要分开用。 */
function valuesOf(tuning) {
  const { warnings, path, ...values } = tuning;
  return values;
}

/**
 * @param {object} [o]
 * @param {object} [o.logger]
 * @param {() => Promise<Array<{id:string,title:string}>>} [o.listSessions]
 *   可选会话（设置页的下拉框）。**失败一律当空列表** —— 会话服务拿不到不该让设置页打不开。
 * @param {() => object} [o.companionStatus] 伴生进程的现状（见 `src/companion.js`）
 * @param {(values:object) => void} [o.onApplied] 配置落盘之后的热重配回调
 */
export function createSettingsApi({ logger, listSessions, companionStatus, onApplied } = {}) {
  function log(line) {
    try {
      logger?.info?.(line);
    } catch {
      /* 记日志失败不该影响接口 */
    }
  }

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};
    return JSON.parse(text);
  }

  /** `{patch}` 包一层，理由见 `/config` 里的注释。 */
  async function patchOf(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      send(res, 400, { ok: false, rejected: [`请求体不是合法 JSON：${err?.message ?? err}`] });
      return undefined;
    }
    const patch = body && typeof body === 'object' ? body.patch : undefined;
    if (patch === undefined) {
      send(res, 400, { ok: false, rejected: ['缺少 patch'] });
      return undefined;
    }
    return patch;
  }

  return async function handle(req, res, connection) {
    // 第一件事永远是过信任栅栏：前缀比内核 `/api` 长，这些请求没经过内核准入。
    const rejection = rejectionFor(req, connection);
    if (rejection !== undefined) {
      send(res, rejection, { ok: false, rejected: ['请求不被信任'] });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      send(res, 400, { ok: false, rejected: ['请求路径无法解析'] });
      return;
    }

    const route = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname;
    const method = String(req.method ?? 'GET').toUpperCase();

    try {
      if (route === '/status') {
        if (method !== 'GET' && method !== 'HEAD') {
          send(res, 405, { ok: false, rejected: ['只支持 GET'] });
          return;
        }
        const tuning = readTuning();
        /**
         * 会话列表：拿不到就回空数组 + 一个说明。**不能让设置页因为这件事 500** ——
         * 用户只是想改个快捷键，会话服务恰好没起来不该连累整个面板。
         */
        let sessions = [];
        let sessionsNote = null;
        try {
          const got = await listSessions?.();
          if (Array.isArray(got)) sessions = got;
          else if (got !== undefined && got !== null) sessionsNote = '会话列表格式不认识（已按空处理）';
        } catch (err) {
          sessionsNote = `拿不到会话列表：${err?.message ?? err}`;
        }
        send(res, 200, {
          ok: true,
          path: tuning.path,
          values: valuesOf(tuning),
          defaults: defaultsPayload(),
          paces: PACES_KEYS,
          writable: { keys: WRITABLE_KEYS, listen: WRITABLE_LISTEN_KEYS },
          local: localPayload(),
          // 悬浮窗样式在另一个文件（watch-window.json），和上面那套互不影响
          window: readWindowStyle(),
          sessions,
          sessionsNote,
          companion: (() => {
            try {
              return companionStatus?.() ?? null;
            } catch (err) {
              return { status: 'error', reason: `读伴生进程状态失败：${err?.message ?? err}` };
            }
          })(),
          warnings: tuning.warnings,
        });
        return;
      }

      if (route === '/config') {
        if (method !== 'POST') {
          send(res, 405, { ok: false, rejected: ['只支持 POST'] });
          return;
        }
        // 包一层 `patch` 而不是整个 body 当补丁：以后加 `dryRun` 之类的元数据时
        // 不用改协议，也不会把元数据误当成配置键。
        const patch = await patchOf(req, res);
        if (patch === undefined) return;

        const result = writeTuning(patch);
        if (result.ok) log(`see-now: 配置已写回 ${result.path}`);
        else log(`see-now: 配置被拒 ${JSON.stringify(result.rejected)}`);

        // 回包给的是**写完之后文件里的完整快照**，不是 `writeTuning().values` ——
        // 后者按"规矩 3"只含这次提交的键，前端拿它当整份配置重建草稿时，
        // 只改 `idleStopMin` 就会让 `values.listen` 整段消失（草稿读它直接抛错）。
        const after = readTuning();
        /**
         * 写成功了才热重配。**失败的那次绝不重配** —— 用户填了个不合法的快捷键、
         * 被拒了，结果快捷键却按新值变了，那是最费解的行为。
         */
        if (result.ok) {
          try {
            onApplied?.(after);
          } catch (err) {
            log(`see-now: 热重配失败 ${err?.message ?? err}`);
          }
        }
        send(res, 200, {
          ok: result.ok,
          path: after.path,
          values: valuesOf(after),
          warnings: result.warnings,
          rejected: result.rejected,
        });
        return;
      }

      if (route === '/local') {
        if (method !== 'POST') {
          send(res, 405, { ok: false, rejected: ['只支持 POST'] });
          return;
        }
        const patch = await patchOf(req, res);
        if (patch === undefined) return;

        const result = writeAsrConfig(patch, { path: asrPath(tuningPath()) });
        if (result.ok) log(`see-now: 转写服务配置已写回 ${result.path}`);
        else log(`see-now: 转写服务配置被拒 ${JSON.stringify(result.rejected)}`);

        send(res, 200, {
          ok: result.ok,
          path: result.path,
          local: localPayload(),
          rejected: result.rejected,
        });
        return;
      }

      if (route === '/window') {
        if (method === 'GET' || method === 'HEAD') {
          send(res, 200, { ok: true, window: readWindowStyle() });
          return;
        }
        if (method !== 'POST') {
          send(res, 405, { ok: false, rejected: ['只支持 GET / POST'] });
          return;
        }
        const patch = await patchOf(req, res);
        if (patch === undefined) return;

        // 只校验传来过的键：`setWindowStyle(undefined)` 会返回"样式不合法"，
        // 那样只改弹幕也会被一个不相干的错误拦住。
        let result = { ok: true, rejected: [] };
        if (patch.style !== undefined) {
          result = setWindowStyle(patch.style, { log });
          if (result.ok) log(`see-now: 悬浮窗样式 → ${result.style}`);
        }
        // 最小化 / 弹幕：和样式一样是"改完 250ms 生效"的键，走同一个接口，
        // 少一套路由就少一处不同步（两个键各有自己的合法值，分别校验）。
        let rejected = result.rejected ?? [];
        let modeResult = null;
        if (patch.mode !== undefined) {
          const want = String(patch.mode ?? '').trim().toLowerCase();
          if (want === 'full' || want === 'hidden' || want === 'mini') {
            // `mini` 是小悬浮窗：窗口还在屏幕上，只是换成两条胶囊。
            // 它写的是 `mode: "mini"` + `hidden: false`，宿主这边没有"藏起来"的语义。
            modeResult = want === 'mini' ? setWindowMini({ log }) : setWindowHidden(want === 'hidden', { log });
          } else {
            rejected = [...rejected, 'mode 必须是 full / mini / hidden'];
          }
        }
        let danmakuResult = null;
        if (patch.danmaku !== undefined) danmakuResult = setWindowDanmaku(Boolean(patch.danmaku), { log });
        // 背景透明度：0.25 ~ 1，窗口每 250ms 读一次盘自己应用
        let opacityResult = null;
        if (patch.opacity !== undefined) {
          const val = Number(patch.opacity);
          if (!Number.isFinite(val) || val < 0.25 || val > 1) rejected = [...rejected, 'opacity 必须是 0.25 ~ 1 之间的数'];
          else opacityResult = setWindowOpacity(val, { log });
        }
        // 气泡/文字/字体：一整组键走 `setWindowUi`，每个都在里面夹区间
        let uiResult = null;
        if (patch.ui !== undefined) {
          uiResult = setWindowUi(patch.ui, { log });
          if (uiResult.ok === false) rejected = [...rejected, ...(uiResult.rejected ?? ['ui 不合法'])];
        }
        const ok = rejected.length === 0
          && result.ok !== false
          && (modeResult?.error === undefined)
          && (danmakuResult?.error === undefined)
          && (opacityResult?.error === undefined)
          && (uiResult?.ok !== false);
        if (uiResult?.changed) log('see-now: 气泡/文字设置已更新');
        send(res, 200, {
          ok,
          window: readWindowStyle(),
          rejected,
        });
        return;
      }

      send(res, 404, { ok: false, rejected: [`没有这条路由：${route}`] });
    } catch (err) {
      // 兜底：任何未预料的异常都要变成一条结构化的答复，而不是断掉的连接 ——
      // 前端在等 JSON，连接一断它只会显示"网络错误"，真正的原因就丢了。
      log(`see-now: 接口异常 ${err?.stack ?? err}`);
      send(res, 500, { ok: false, rejected: [String(err?.message ?? err)] });
    }
  };
}
