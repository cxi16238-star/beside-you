/**
 * portal-capture.js — Linux 的屏幕帧源：xdg-desktop-portal ScreenCast + PipeWire。
 *
 * 为什么不走 ffmpeg：Linux 上 ffmpeg 只有 x11grab（XWayland 的根窗口里没有原生
 * Wayland 窗口，抓到的是空的）和 kmsgrab（要 DRM master / root）。Wayland 下正确
 * 的路子是 portal 的 ScreenCast：一次授权 → 拿到 PipeWire 节点 → 连续收流。
 *
 * 和 `spawnFrames()`（ffmpeg）的**契约完全一致**：
 *   - 出参都是 `{ done, stop }`
 *   - `done` resolve `{ frames, ms, code, ended? }`，reject 的 error 带 `errorInfo`
 *   - 逐帧回调 `onFrame({ i, t, buf })`，`buf` 是 `width*height*3` 的 rgb24
 * 所以 runner 只需要在 spawn 那一个点上分叉，上游的判帧/拼图一行都不用改。
 *
 * worker 是 `portal_stream.py`（portal 握手 + gst 收流），它只干两件事：把帧写到
 * stdout、把日志和握手结果写到 stderr。这里负责切帧、背压、重连、错误分类和生命周期。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const WORKER = fileURLToPath(new URL('./portal_stream.py', import.meta.url));

/**
 * 上一次停采集的时刻（模块级）。
 *
 * KDE 的 portal 在「刚关掉的会话还没彻底回收」时接受新的 Start，会握手成功但一帧
 * 都不来 —— 实测 stop 后立刻换个 region/quality 再 watch，十次里能中三四次。
 * 隔 4 秒再开会话就正常。所以新采集在旧采集停掉后至少等 `RESTART_SETTLE_MS`。
 */
let lastStopAt = 0;
const RESTART_SETTLE_MS = 1500;

/** 按发行版给出装包命令 —— 提示写死成 pacman 在 Ubuntu 上等于没写。 */
export function installHint() {
  const has = (bin) => {
    try { return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0; } catch { return false; }
  };
  if (has('pacman')) return 'pacman -S python-gobject gstreamer gst-plugin-pipewire';
  if (has('apt')) return 'sudo apt install python3-gi gstreamer1.0-tools gstreamer1.0-pipewire';
  if (has('dnf')) return 'sudo dnf install python3-gobject gstreamer1-plugins-base pipewire-gstreamer';
  if (has('zypper')) return 'sudo zypper install python3-gobject gstreamer pipewire-gstreamer';
  return '装上 python-gobject / gstreamer / gst-plugin-pipewire（发行版各自的包名）';
}

/** 依赖缺失时给一句能照做的话（和 capture.js 的 CAPTURE_HINTS 同一个用途）。 */
export const PORTAL_HINTS = Object.freeze({
  'dependency-missing': 'Linux 屏幕采集要 python-gobject + gstreamer + gst-plugin-pipewire：'
    + installHint(),
  'permission-denied': '桌面拒绝了选屏授权：重新 watch 一次，在弹出的选屏框里点"允许 / 共享"。'
    + '之前点过拒绝的话，删掉 ~/.dsh/see-now/portal-token.json 再来。',
  'capture-failed': '共享中断：用户点了"停止共享"、显示器休眠、或 KWin 重启过。'
    + '已经自动重连过还是失败 —— 下一次 watch 会再试；一直失败就看 xdg-desktop-portal '
    + '是否在跑（systemctl --user status xdg-desktop-portal）。',
});

/** 找 python。DSH_PYTHON_PATH 显式指定优先，其次 PATH 里的 python3。 */
export function resolvePython({ env = process.env } = {}) {
  const explicit = env.DSH_PYTHON_PATH || env.DSH_SEE_PYTHON;
  if (explicit) return explicit;
  return 'python3';
}

/** 退出码 → 错误分类。worker 的约定在 portal_stream.py 文件头。 */
function classify(code, stderrTail) {
  const tail = String(stderrTail ?? '');
  if (code === 1 || /python3-gi|gst-inspect|pipewiresrc|module named 'gi'/i.test(tail)) {
    return 'dependency-missing';
  }
  if (code === 2 || /被拒绝|取消|cancelled|denied/i.test(tail)) return 'permission-denied';
  return 'capture-failed';
}

/**
 * 起一个 portal 采集进程（带重连）。
 *
 * 重连：worker 用退出码 3/4 表示"流断了 / 握手失败"（用户点了停止共享、显示器休眠、
 * KWin 重启、portal 一时没响应）。这些都是**可恢复**的，而 see-now 的语义是"陪着看"，
 * 断一次就把整条 watch 判死太脆。所以这里在内部重开 worker 最多 `maxAttempts` 次，
 * 帧序号和回调照旧往下走；只有重连也用完了才 reject。
 *
 * 退出码 1/2（缺依赖 / 用户拒绝授权）**不重连** —— 那是要用户动手的事，重试只会刷屏。
 *
 * @returns {{done: Promise<{frames:number, ms:number, code:number|null}>, stop: () => void}}
 */
export function spawnPortalFrames({
  width, height, fps = 12,
  pythonPath = resolvePython(),
  workerPath = WORKER,
  // 指示框裁剪：{logicalWidth, logicalHeight, edge, top}（全是**逻辑像素**）
  crop = null,
  /**
   * 只看一块：{x,y,w,h}，坐标是**采集流坐标系**（portal `Start` 报的 size，不是屏幕物理像素）。
   *
   * 实测两套坐标（同一台 2560×1600 屏、KDE Wayland）：
   *   缩放 125% → 流 2048×1280 ↔ 物理 2560×1600（×1.25）
   *   缩放 150% → 流 1707×1067 ↔ 物理 2560×1600（×1.5）
   * GNOME/X11 100%（1280×800）两者相同（×1.0）。比例**不保证整数**，取框窗那边按 x/y
   * 各自换算后再夹回流范围（见 `pick_region.py: scale_rect`）。
   */
  region = null,
  // worker 报到时回调一次：{stream_width, stream_height, region, node}
  onReady = null,
  onFrame, onStderr = null, onFirst = null,
  stderrLimit = 4000,
  maxAttempts = 3,
  retryDelayMs = 800,
  // 多久还没出第一帧就当成"卡住了"重开一次（portal 偶尔会握手成功但不出帧）
  firstFrameMs = 12000,
} = {}) {
  if (!existsSync(workerPath)) throw new Error(`portal worker 不见了：${workerPath}`);
  const t0 = Date.now();

  let child = null;
  let n = 0;
  let err = '';
  let stopping = false;
  let attempt = 0;
  let retryTimer = null;
  let firstTimer = null;
  let restarting = false;

  const deliver = (buf) => {
    const i = n;
    n += 1;
    if (i === 0) onFirst?.(Date.now() - t0);
    onFrame?.({ i, t: i / fps, buf });
  };

  const done = new Promise((resolve, reject) => {
    const settle = (code, kind) => {
      clearRetry();
      if (kind === 'resolve') resolve({ frames: n, ms: Date.now() - t0, code });
      else reject(code);
    };

    const clearRetry = () => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    };

    const failure = (code) => {
      const stderrTail = err.trim().slice(-1000) || null;
      const category = classify(code, stderrTail);
      const error = new Error(
        `portal 采集退出 ${code}（运行 ${Math.round((Date.now() - t0) / 1000)}s / ${n} 帧）: `
        + `${err.trim().split('\n').slice(-3).join(' ') || '无 stderr'}`,
      );
      error.code = code;
      error.stderrTail = stderrTail;
      error.errorInfo = { category, stage: 'exit', code, signal: null, stderrTail };
      const hint = PORTAL_HINTS[category];
      if (hint) error.message += `\n  ↳ ${hint}`;
      return error;
    };

    const launch = () => {
      attempt += 1;
      const c = spawn(pythonPath, [
        workerPath,
        '--fps', String(fps),
        '--width', String(width),
        '--height', String(height),
        ...(crop ? ['--logical-width', String(crop.logicalWidth ?? 0),
          '--logical-height', String(crop.logicalHeight ?? 0),
          '--edge', String(crop.edge ?? 0),
          '--top-band', String(crop.top ?? 0)] : []),
        ...(region ? ['--region', `${region.x},${region.y},${region.w},${region.h}`] : []),
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      child = c;

      /**
       * 帧协议：**每帧 4 字节大端长度 + 负载**（只在 portal 这条路上）。
       *
       * 为什么不用裸流：换清晰度/region 会改帧长，裸流要靠"我上次告诉它多大"这种
       * 跨进程状态来对齐 —— stdout 和 stderr 是两条管道，顺序没有保证。
       * 长度头让每帧自带边界，重开 gst 时也不可能切歪。
       */
      let buf = Buffer.alloc(0);
      c.stdout.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let off = 0;
        while (buf.length - off >= 4) {
          const len = buf.readUInt32BE(off);
          if (len <= 0 || buf.length - off - 4 < len) break;
          // 复制一份：subarray 会让整块 chunk 一直活着
          deliver(Buffer.from(buf.subarray(off + 4, off + 4 + len)));
          off += 4 + len;
        }
        if (off) buf = Buffer.from(buf.subarray(off));
      });

      /**
       * **12 秒一帧都没有 → 重开一次。**
       *
       * 实测 KDE 的 portal 偶尔会"握手成功、gst 也起了，但一帧都不来"（多次重开
       * 采集 / portal 重启之后尤其常见）。以前这种情况要等满整个 watch（可能 300 秒）
       * 才回一句"没看成"，看起来就像插件坏了。现在 12 秒没帧就自己重开，
       * 最多还是 maxAttempts 次。
       */
      clearTimeout(firstTimer);
      firstTimer = setTimeout(() => {
        if (stopping || n > 0) return;
        restarting = true;
        onStderr?.(`[portal] ${Math.round(firstFrameMs / 1000)} 秒还没出帧，重开采集`);
        try { c.kill('SIGTERM'); } catch { /* 已退出 */ }
      }, firstFrameMs);
      firstTimer.unref?.();

      // 第一行 JSON 是握手结果（node / frame_bytes / fps），其余当日志往上传。
      const rl = readline.createInterface({ input: c.stderr });
      rl.on('line', (line) => {
        err = `${err}${line}\n`.slice(-stderrLimit);
        if (line.startsWith('{')) {
          try {
            const info = JSON.parse(line);
            if (info?.ready) onReady?.(info);
          } catch { /* 不是 JSON 就当日志 */ }
        }
        onStderr?.(line);
      });

      c.on('error', (e) => {
        // 最常见的是 python 不在 PATH（ENOENT）
        e.errorInfo = {
          category: e?.code === 'ENOENT' ? 'dependency-missing' : 'capture-failed',
          stage: 'spawn', code: e?.code ?? null, signal: null, stderrTail: err.trim().slice(-1000) || null,
        };
        if (e?.code === 'ENOENT') e.message = `找不到 python（${pythonPath}）：${e.message}`;
        settle(e, 'reject');
      });

      c.on('close', (code) => {
        if (child !== c) return;          // 已经被覆盖（重连过一次）
        child = null;
        clearTimeout(firstTimer);
        if (restarting) {
          restarting = false;
          if (attempt < maxAttempts && !stopping) {
            retryTimer = setTimeout(() => { retryTimer = null; launch(); }, retryDelayMs);
            return;
          }
        }
        // 重开几次还是 0 帧：给一句能照做的话，而不是让 watch 空等
        if (n === 0 && attempt >= maxAttempts && !stopping) {
          const error = new Error(
            `portal 采集试了 ${maxAttempts} 次都没出帧 —— 多半是 xdg-desktop-portal 卡住了，`
            + '跑 `systemctl --user restart xdg-desktop-portal` 再试',
          );
          error.errorInfo = {
            category: 'capture-failed', stage: 'exit', code, signal: null,
            stderrTail: err.trim().slice(-1000) || null,
          };
          settle(error, 'reject');
          return;
        }
        // code === null = 被我们自己 kill 的（stop / 换清晰度 / 收工），那是正常收尾
        if (code === null || stopping) { settle(null, 'resolve'); return; }
        if (code === 0) { settle(code, 'resolve'); return; }
        // 3/4 = 流断 / 握手失败：可恢复，重连；1/2 = 缺依赖 / 被拒：不重连
        if ((code === 3 || code === 4) && attempt < maxAttempts && !stopping) {
          onStderr?.(`[portal] 采集中断（exit ${code}），${retryDelayMs}ms 后重连：`
            + `第 ${attempt + 1}/${maxAttempts} 次`);
          // 这个定时器**不能 unref**：它和"刚退出的子进程"之间没有任何别的 handle，
          // unref 之后事件循环会以为没事可做直接退出，重连就永远不会发生。
          retryTimer = setTimeout(() => { retryTimer = null; launch(); }, retryDelayMs);
          return;
        }
        settle(failure(code), 'reject');
      });
    };

    // 刚停过就先等一会儿：给 portal 时间回收上一个会话
    const delayMs = Math.max(0, RESTART_SETTLE_MS - (Date.now() - lastStopAt));
    if (delayMs > 0) {
      onStderr?.(`[portal] 上一次采集刚停，等 ${delayMs}ms 再开新会话`);
      retryTimer = setTimeout(() => { retryTimer = null; launch(); }, delayMs);
    } else {
      launch();
    }
  });

  return {
    done,
    /**
     * 热更新：只让 worker 重开 gst，**不重开 portal 会话**。
     *
     * 这里把 Node 侧的形状翻成 worker 的线格式（`crop` 对象 → 扁平的
     * logical_width/edge/top_band，`region` 对象 → [x,y,w,h]），免得两边各记一套。
     */
    update({ width, height, fps, region, crop } = {}) {
      const c = child;
      if (!c || !c.stdin || c.stdin.destroyed) return false;
      const msg = { cmd: 'update' };
      if (width) msg.width = width;
      if (height) msg.height = height;
      if (fps) msg.fps = fps;
      msg.region = region ? [region.x, region.y, region.w, region.h] : null;
      if (crop && crop.logicalWidth) {
        msg.logical_width = crop.logicalWidth;
        msg.logical_height = crop.logicalHeight;
        msg.edge = crop.edge;
        msg.top_band = crop.top;
      } else {
        msg.edge = 0;
        msg.top_band = 0;
      }
      try {
        c.stdin.write(`${JSON.stringify(msg)}\n`);
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      stopping = true;
      lastStopAt = Date.now();
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      // **不要把 child 置空**：close 回调靠 `child === c` 判断这一条是不是当前进程，
      // 置空会让它提前 return，`done` 永远不 settle（teardown 就吊死在这里）。
      const c = child;
      if (!c) return;
      try { c.kill('SIGTERM'); } catch { /* 已经没了 */ }
      // gst 偶尔会拖住 SIGTERM：1.5 秒后补一刀，别让 teardown 吊死
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }, 1500);
      t.unref?.();
    },
  };
}
