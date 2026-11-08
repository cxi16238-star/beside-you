/**
 * indicator.js — 采集期间的屏幕指示框（贴边光晕 + 顶部状态条）的进程管理。
 *
 * 为什么要有它：`see_now` 在后台一直看着屏幕，用户需要一个"现在有人在看"的可见信号，
 * 而且这个信号必须**只给用户看、不进模型的图**。
 *
 * 具体分四步：
 *   1. `indicator.py` 画一条全屏、点击穿透、不抢焦点的光晕 + 状态条；
 *   2. 它启动后往 stdout 打一行 JSON（`dpr` / 几何），这里据此算**设备像素**的裁剪量；
 *   3. 裁剪量交给 `portal_stream.py`，在 gst 里 `videocrop` 掉 —— 模型看到的图里没有框；
 *   4. Wayland 下置顶靠 KWin 脚本（`kwin-indicator.js`），Qt 的 StayOnTop 不生效。
 *
 * 失败不致命：画不出来只是少一个提示，采集照旧（裁剪量退回 0）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./indicator.py', import.meta.url));
const KWIN_SCRIPT = fileURLToPath(new URL('./kwin-indicator.js', import.meta.url));

/** 和 indicator.py 里的常量保持一致（逻辑像素）。 */
export const EDGE = 26;
export const TOP_BAND = 55;

let proc = null;
let meta = null;
let kwinTried = false;

/** 找一个能用的 qdbus（Plasma 6 是 qdbus6）。 */
function qdbusBin() {
  for (const bin of ['qdbus6', 'qdbus']) {
    const r = spawnSync('which', [bin], { stdio: 'ignore' });
    if (r.status === 0) return bin;
  }
  return null;
}

/**
 * 让光晕窗在 KWin 里置顶。**只在 KDE 上、只在第一次需要时试一次**。
 * 失败只是"可能被别的窗口盖住"，不影响采集，所以全静默。
 */
export function ensureKwinKeepAbove(log = () => {}) {
  if (kwinTried) return;
  kwinTried = true;
  const bin = qdbusBin();
  if (!bin) { log('[indicator] 没找到 qdbus6/qdbus，跳过 KWin 置顶'); return; }
  try {
    const load = spawnSync(bin, ['org.kde.KWin', '/Scripting',
      'org.kde.kwin.Scripting.loadScript', KWIN_SCRIPT], { encoding: 'utf8', timeout: 5000 });
    if (load.status !== 0) {
      log(`[indicator] KWin 脚本加载失败：${String(load.stderr || '').trim().slice(0, 200)}`);
      return;
    }
    spawnSync(bin, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.start'],
      { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    log(`[indicator] KWin 置顶失败：${e?.message ?? e}`);
  }
}

export function indicatorState() {
  return meta ? { ...meta, running: Boolean(proc) } : { running: false };
}

/**
 * 起指示框（幂等：已经在跑就直接返回上次那组数字）。
 *
 * @returns {Promise<{ok: true, logicalWidth: number, logicalHeight: number, edge: number, top: number}
 *                 | {ok: false, reason: string}>}
 */
export async function startIndicator({
  pythonPath = 'python3', log = () => {}, timeoutMs = 8000, env = {},
} = {}) {
  if (proc && meta) return { ok: true, ...meta };
  if (proc) return { ok: true, ...(meta ?? { edge: EDGE, top: TOP_BAND }) };

  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const child = spawn(pythonPath, [SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    proc = child;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      log('[indicator] 8 秒没报到，按"没起来"处理（采集照旧，框不显示）');
      finish({ ok: false, reason: 'timeout' });
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    }, timeoutMs);
    timer.unref?.();

    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString();
      const nl = pending.indexOf('\n');
      if (nl < 0) return;
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      let info = null;
      try { info = JSON.parse(line); } catch { return; }
      if (!info?.ready) return;
      /**
       * **不要用 Qt 报的 `dpr` 换算裁剪量**：这台机器上 Qt 报 2.0，而实际缩放是 1.25
       * （屏幕 2560×1600、逻辑 2048×1280）—— 按 dpr 算会把画面裁掉一大块。
       *
       * 可靠的是**逻辑几何**：光晕就是画在逻辑坐标上的 26px。所以把逻辑宽高和
       * 逻辑像素的边宽交给 worker，让 gst 先缩到逻辑尺寸再按像素裁。
       */
      const geo = Array.isArray(info.geometry) ? info.geometry : null;
      const logicalWidth = geo && geo[2] > 0 ? geo[2] : null;
      const logicalHeight = geo && geo[3] > 0 ? geo[3] : null;
      meta = {
        dpr: Number(info.dpr) > 0 ? Number(info.dpr) : 1,
        logicalWidth,
        logicalHeight,
        edge: EDGE,
        top: TOP_BAND,
        geometry: geo,
      };
      ensureKwinKeepAbove(log);
      log(`[indicator] 起来了：逻辑 ${logicalWidth}×${logicalHeight}，`
        + `裁 ${EDGE}px 边 / ${TOP_BAND}px 顶（逻辑像素）`);
      finish({ ok: true, ...meta });
    });

    child.stderr.on('data', (d) => {
      stderr = `${stderr}${d}`.slice(-2000);
      if (process.env.DSH_SEE_NOW_DEBUG) log(`[indicator] ${String(d).trim()}`);
    });

    child.on('error', (e) => {
      proc = null;
      finish({ ok: false, reason: `spawn 失败：${e?.message ?? e}` });
    });

    child.on('close', (code) => {
      proc = null;
      const tail = stderr.trim().split('\n').slice(-2).join(' ');
      if (!settled) {
        // 最常见：没装 PySide6，python 直接 ImportError 退出
        finish({ ok: false, reason: `指示框进程退出（code=${code}）${tail ? `：${tail}` : ''}` });
      } else if (meta) {
        log(`[indicator] 指示框退出（code=${code}）`);
      }
      meta = null;
    });
  });
}

/** 停掉指示框。调用方负责"要不要停"的判断（换清晰度时不该停，见 runner）。 */
export function stopIndicator() {
  const child = proc;
  proc = null;
  meta = null;
  if (!child) return;
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 1200);
  t.unref?.();
}
