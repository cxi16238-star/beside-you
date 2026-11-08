/**
 * capture.js — 唯一 spawn ffmpeg 的地方。**一根 rawvideo 管道**，不再切分片。
 *
 * 为什么不是「2 秒一片 + `-ss` 回抓」：分片必须关闭才能 seek，光这一条就是 2 秒固定延迟；
 * 每抓一帧还要 spawn 一次 ffmpeg（实测 135ms）。实时场景要的是「帧到手就判、判完就留」，
 * 所以直接 `-f rawvideo` 吐 rgb24，帧在内存里，留帧零成本。
 *
 * ## 三种源的实测（Windows 机 2560×1600 屏 / i9-12900HX，12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `ddagrab`（桌面复制 API） | 370 ms | **0.28 核** | 走 GPU，屏幕的原生路子 |
 * | `gdigrab`（GDI 抓屏） | 310 ms | 0.45 核 | 每帧先从 GDI 拷 2560×1600 BGRA = **16 MB** 再缩 |
 * | `obs`（OBS 虚拟摄像头） | 575 ms | 0.13 核 | 设备侧已经缩好了，最省 |
 * | `camera`（USB 摄像头） | **1450 ms** | 0.14 核 | 首帧慢是**硬件唤醒**，参数救不了 |
 * | Nikon Webcam Utility（客户端没开） | — | 0.80 核 | 只有 3.4 fps，等于卡死 |
 *
 * 结论：屏幕源**默认用 ddagrab**，跑不起来退回 gdigrab；设备源别停进程 —— 首帧延迟只能靠常驻摊掉。
 *
 * ## gdigrab 全屏到底贵在哪，以及四条"优化"为什么都是假的（2026-11-05 实测）
 *
 * 社区报「ddagrab 起不来、退 gdigrab 之后一放视频就卡」，所以把 gdigrab 的成本拆开量了一遍。
 * 条件：2560×1600 → 798×450 / 12fps，i9-12900HX，ffmpeg 7.0，`-f null` 出图（排除管道开销），
 * 3 轮交替取最小（笔电会升降频，单次数字能差一倍，别信）。
 *
 * | 这一档只做 | 核 | 每帧 |
 * |---|---|---|
 * | GDI 拷屏（`-vf null`） | 0.141 | 11.9 ms |
 * | + BGRA→rgb24 | 0.174 | 14.7 ms |
 * | + `scale=area`（线上这条） | 0.347 | 29.3 ms |
 *
 * **六成的钱花在缩放上，不是拷屏上。** 四条看着有戏的路，实测全不成立：
 *
 * ① `-video_size 800x450` 让 gdigrab 少拷一点 —— **它是裁剪，不是缩放**。
 *    与 `crop=800:450:0:0` **逐字节相同**，与 `scale=800:450` 平均像素差 70.5。
 *    真按这个"优化"，插件只会看到屏幕左上角，而且看不出是坏的（画面正常、有内容）。
 * ② `flags=fast_bilinear` 换掉 `area` —— CPU 降到 0.201 核（-42%），但以 `lanczos` 为参照
 *    SSIM 只有 **0.877**，`area` 是 **0.989**；800×450 下界面文字明显发糊。
 *    这个插件产出的是给模型读屏的图，**不换**。
 * ③ `-threads 1` / `-filter_threads` —— 无收益（0.239~0.257 核）。swscale 在单个 scale
 *    滤镜内部本来就切片并行，外面再给线程只是抢核。
 * ④ `zscale`（libzimg）—— 更慢（0.35 核），因为它要先把 packed rgb24 拆成平面。
 *
 * 结论：**gdigrab 全屏的代价是 GDI + swscale 的固有成本，改滤镜参数救不回来。**
 * 想省钱只有三条路：换 ddagrab、少抓帧、只抓那一块窗口（region 的 BitBlt 只拷 region；
 * ffmpeg 7.0 还支持 `-i hwnd=<句柄>` 直接抓窗口）。
 *
 * ## 一个反直觉的数：别默认"ddagrab 一定更省"
 *
 * 本机把两个引擎交替各跑两轮 5 秒（`798×450 / 12fps`，和 `scripts/bench-capture.mjs` 同一条命令链）：
 *
 * | 轮次 | gdigrab | ddagrab |
 * |---|---|---|
 * | 1 | 0.22 核 | 0.49 核 |
 * | 2 | 0.18 核 | 0.23 核 |
 *
 * **静止桌面上 gdigrab 反而赢**，而且同一个命令相邻两轮能差一倍多（升降频 + 屏幕有没有在动）。
 * 上面那张"373ms / 0.28 核 vs 310ms / 0.45 核"的老表是另一台机器、另一种屏幕内容量的，
 * 两者不矛盾但**不能互相外推** —— 谁快谁慢得用 `scripts/bench-capture.mjs` 现量，
 * 而且要交替两轮取小。所以这条分支的判断依据永远是"能不能出帧"，不是"哪个更快"。
 *
 * ## macOS（M 系列 / Retina，同样 12fps → 800×450）
 *
 * | 源 | 首帧 | CPU | 备注 |
 * |---|---|---|---|
 * | `avfoundation` 屏幕 | **~700 ms** | **~0.16 核** | 起会话慢（AVCaptureSession 冷启动），稳态最省 |
 *
 * 两条 macOS 特有的坑，都写在对应函数里，别删：
 *
 * ① **`-framerate` 在 avfoundation 屏幕源上不压速**。实测 `-frames:v 30` 只用 0.73 秒
 *    （≈40fps），挂上 `-r 12` 才是 3.05 秒。少了这一条，管道会被帧灌满 ——
 *    开发时真被灌出过 **240 GB / 几分钟**的 raw 文件。所以屏幕源在 macOS 上必须挂 `-r`，
 *    而 Windows 的 ddagrab/gdigrab 已经按 fps 抓了，再挂就是白跑一趟。
 *
 * ② **没有「屏幕录制」权限时它不报错，只给你一片纯黑**。exit code 还是 0，
 *    帧数正常，字节数正常。所以探针除了看"有没有帧"，还要看"帧里有没有东西"。
 */

import { spawn } from 'node:child_process';

/** macOS 上屏幕设备的默认名字。`-list_devices` 里它永远是英文，相机才是本地化的。 */
export const DEFAULT_SCREEN_DEVICE = 'Capture screen 0';

/**
 * 纯黑帧的提示语。macOS 不会告诉你"权限没给"，只会默默给黑屏 ——
 * 这句是唯一能把人从"插件坏了"领到"系统设置"的路标。
 */
export const SCREEN_PERMISSION_HINT =
  'ffmpeg 没有「屏幕录制」权限：系统设置 → 隐私与安全性 → 屏幕录制，勾上跑 DSH 的那个 App（或终端），重启它再试。';

/**
 * 把采集失败归成能直接照着做的一类。
 *
 * 原来所有失败都只有一句 "ffmpeg exit 1"，用户分不清是没装 ffmpeg、没给权限，
 * 还是设备名不对（#6 的核心诉求）。判据只用 stderr 里的明文证据，不猜。
 *
 * @param {Error & {code?:string|number, stderrTail?:string|null}} error
 * @param {'spawn'|'exit'|'list'} stage
 */
export function captureErrorInfo(error, stage = 'exit') {
  if (error?.errorInfo) return error.errorInfo;
  const message = `${error?.message ?? error}\n${error?.stderrTail ?? ''}`;
  const category = error?.code === 'ENOENT' || /找不到 FFmpeg|spawn.*ENOENT/i.test(message)
    ? 'dependency-missing'
    : error instanceof RangeError ? 'invalid-input'
      : /permission denied|not authorized|operation not permitted|screen recording permission/i.test(message)
        ? 'permission-denied'
        : /device.*(?:not found|invalid)|invalid.*device|could not find.*device|video device.*not available/i.test(message)
          ? 'device-unavailable'
          : 'capture-failed';
  return {
    category,
    stage,
    code: error?.code ?? null,
    signal: error?.signal ?? null,
    stderrTail: error?.stderrTail ?? null,
  };
}

/** 分类 → 一句能照做的话。只给用户/模型看的，不参与判断。 */
export const CAPTURE_HINTS = Object.freeze({
  'dependency-missing': '没找到 ffmpeg：装一个，或用 DSH_FFMPEG_PATH 指到绝对路径。',
  'invalid-input': '参数不合法：region 必须是物理像素整数、宽高为正。',
  'permission-denied': SCREEN_PERMISSION_HINT,
  'device-unavailable': '设备名不对或没插上：换成可用的设备，或不传 device 用默认屏幕。',
  'capture-failed': '采集失败：看 stderrTail，那几行通常就是原因。',
});

/** 源描述 → 输入参数。纯函数，可单测。 */
export function sourceArgs(
  source = { kind: 'screen' },
  { engine = 'auto', fps = 12, platform = process.platform, pixelFormat = null } = {},
) {
  const s = source ?? {};
  const mac = platform === 'darwin';

  switch (s.kind) {
    case 'obs':
    case 'camera': {
      const fallback = s.kind === 'obs' ? 'OBS Virtual Camera' : 'HD Webcam';
      const device = s.device ?? fallback;
      if (mac) {
        // macOS 没有 dshow；OBS 虚拟摄像头/本机摄像头都以设备身份出现在 avfoundation 里，
        // 名字和索引都能用。`-framerate` 在这里是**设备侧采样率**，必须给。
        return ['-f', 'avfoundation', '-framerate', String(fps), '-i', `${device}:none`];
      }
      // **不要加 `-thread_queue_size`**：部分 ffmpeg build（gyan.dev 2026-10-29 full）
      // 会把放在 `-i` 前的它判成输出选项，直接报 "cannot be applied to input url"，
      // 设备源一帧都出不来（#17 用 bisect 定位）。dshow 的缓冲由 `-rtbufsize` 给，够用。
      return ['-rtbufsize', '256M', '-f', 'dshow', '-i', `video=${device}`];
    }
    case 'screen': {
      if (mac || s.engine === 'avfoundation' || engine === 'avfoundation') {
        // ① 屏幕合成不走 GPU 路径，只能靠 AVFoundation 推流；
        // ② `-capture_cursor` 必须显式给（默认值随系统版本变，不能靠）；
        // ③ 音频写 `none`，否则某些系统会去开麦克风，触发额外的权限弹窗；
        // ④ `-pixel_format` 不给就默认 yuv420p，而屏幕输入**不支持** yuv420p ——
        //    每进程刷一行 "not supported" 到 stderr。探针会挑一个设备真收的格式，
        //    顺手把那行噪音也消掉（否则真出错时被截断的 300 字里全是它）。
        const pf = s.pixelFormat ?? pixelFormat;
        return ['-f', 'avfoundation', '-framerate', String(fps),
          ...(pf ? ['-pixel_format', pf] : []),
          '-capture_cursor', s.mouse ? '1' : '0',
          '-i', `${s.device ?? DEFAULT_SCREEN_DEVICE}:none`];
      }
      /**
       * region 走 gdigrab。**原因不是"ddagrab 不支持 region"** —— 它有
       * `offset_x` / `offset_y` / `video_size` 三个 **filter 选项**。
       * 2026-11-05 实测（2560×1600，取 200,120 处 800×450）：
       * ddagrab 与 gdigrab 抓同一块区域**逐字节相同**，与"左上角 800×450 裁剪"平均差 55.5 ——
       * 偏移是真的生效的。
       *
       * 还不能切的理由：region 的用户多半在盯一个窗口，gdigrab 的 `-video_size`
       * 只 BitBlt 那一块（不是整屏），代价本来就小；换 ddagrab 要整条走 hwdownload 路径，
       * 收益没量过 —— 要动先拿 `scripts/bench-capture.mjs` 比一遍。
       *
       * 唯一**绝对不能**做的是把 `-offset_x` 当**输入**参数塞给 ddagrab：
       * 它是 filter source，输入侧的这类参数会被静默丢掉（抓到整屏，用户以为生效了）。
       */
      const useDda = !s.region
        && (s.engine === 'ddagrab' || (s.engine !== 'gdigrab' && engine !== 'gdigrab'));
      if (!useDda) {
        // gdigrab 的 -framerate 是**设备侧**采样率，必须给，否则默认 29.97 白解码
        const region = s.region
          ? ['-offset_x', String(s.region.x), '-offset_y', String(s.region.y),
            '-video_size', `${s.region.w}x${s.region.h}`]
          : [];
        return ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', ...region,
          '-i', s.desktop ?? 'desktop'];
      }
      // ddagrab 是 filter source，输入侧没有帧率参数。
      // `output_idx` / `allow_fallback` 只在探测发现默认值不可用时才出现 ——
      // 正常机器上这一段仍拼出和以前一模一样的字符串（见 probeDdagrab 的注释）。
      {
        const dda = [`framerate=${fps}`, `draw_mouse=${s.mouse ? 1 : 0}`];
        const idx = Number.isInteger(s.outputIdx) ? s.outputIdx : cachedOutputIdx;
        if (Number.isInteger(idx)) dda.push(`output_idx=${idx}`);
        if (s.allowFallback) dda.push('allow_fallback=1');
        return ['-f', 'lavfi', '-i', `ddagrab=${dda.join(':')}`];
      }
    }
    case 'file': {
      const seek = s.seek ?? s.startSec;
      if (seek != null && (!Number.isFinite(seek) || seek < 0)) throw new RangeError('file seek 必须是非负秒数');
      // `realtime` 才加 -re；离线跑要看的是「管线本身多快」，不能被播放速度骗了
      return [...(s.realtime ? ['-re'] : []), ...(seek > 0 ? ['-ss', String(seek)] : []), '-i', String(s.path)];
    }
    case 'rtmp':
      return s.listen === false ? ['-i', String(s.url)] : ['-listen', '1', '-i', String(s.url)];
    default:
      throw new RangeError(`unknown source kind: ${s.kind}`);
  }
}

/** ddagrab 出来的帧还在 GPU 上，得先 hwdownload 再缩。 */
function isDda(source, engine, platform = process.platform) {
  if (source?.kind !== 'screen') return false;
  const e = source?.engine ?? engine;
  if (e === 'ddagrab') return true;
  // `auto` 在 Windows 上默认就是 ddagrab；macOS 上它不是候选，别给它套 hwdownload
  return e === 'auto' && platform !== 'darwin';
}

/**
 * 完整的采集命令。
 *
 * **`-r` 只在需要压速时才挂**：gdigrab/ddagrab 已经按 fps 抓了，再串一个 fps 滤镜是白跑一趟
 * （实测 12fps 下省 3–5% CPU）。但 avfoundation 的屏幕源不认 `-framerate` 当节流阀，
 * 必须靠输出侧 `-r` 把 40fps 压回 12fps —— 见文件头 macOS 坑 ①。
 */
export function captureArgs({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  fast = true, sws = 'area', platform = process.platform,
} = {}) {
  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
  const engineUsed = source?.engine ?? engine;
  if (fast) {
    // `-fflags nobuffer` 只对**直播式**输入有意义，而且它会把 `-re` 的文件回放直接堵死
    // （实测：加上它、配上 -re，4 秒一个字节都不出；去掉立刻 57MB）。
    if (source?.kind !== 'file') args.push('-fflags', 'nobuffer');
    args.push('-flags', 'low_delay');
    if (source?.kind === 'obs' || source?.kind === 'camera') {
      args.push('-probesize', '32', '-analyzeduration', '0');
    }
  }
  args.push(...sourceArgs(source, {
    engine, fps, platform,
    pixelFormat: source?.pixelFormat !== undefined
      ? source.pixelFormat
      : (platform === 'darwin' && source?.kind === 'screen' ? cachedFormat : null),
  }));
  args.push('-an', '-sn');

  const filters = [];
  if (isDda(source, engine, platform)) filters.push('hwdownload', 'format=bgra');
  // avfoundation 没有 gdigrab 那种 `-video_size` 局部抓取，裁剪只能在滤镜里做。
  // 坐标按**采集分辨率**算（Retina 上是逻辑分辨率的 2 倍），不做自动换算。
  if (source?.kind === 'screen' && (platform === 'darwin' || engineUsed === 'avfoundation') && source?.region) {
    const r = source.region;
    filters.push(`crop=${r.w}:${r.h}:${r.x}:${r.y}`);
  }
  filters.push(`scale=${width}:${height}:flags=${sws}`);
  args.push('-vf', filters.join(','));

  if (source?.kind !== 'screen' || (platform === 'darwin' || engineUsed === 'avfoundation')) {
    args.push('-r', String(fps));
  }
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  return args;
}

/**
 * 逐帧读，**同步回调**。回调里做的事会直接变成对 ffmpeg 的背压 —— 这是刻意的：
 * 判帧、留帧、重排都在回调里跑完，绝不让帧在内存里越堆越多。
 *
 * @returns {{stop:()=>void, done:Promise<{frames:number, ms:number, code:number|null}>}}
 */export function spawnFrames({
  source, width, height, fps, ffmpegPath = 'ffmpeg', engine = 'auto',
  onFrame, onStderr = null, onFirst = null,
  // 文件源的起点秒数：seek 之后时间戳必须从这里起算，否则每帧都差一个偏移，
  // 台词（按 wallTo 对齐）会和画面对不上。
  baseSec = source?.seek ?? source?.startSec ?? 0,
} = {}) {
  const args = captureArgs({ source, width, height, fps, ffmpegPath, engine }).slice(1);
  // windowsHide：Windows 上 spawn 控制台程序会新开一个黑框，采集是常驻的，
  // 不加就是"每几秒闪一下"（issue #37）。非 Windows 平台这个键被忽略。
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const need = width * height * 3;
  /**
   * 拼帧缓冲：**一帧只分配一次、只拷贝一次**。
   *
   * 旧写法是 `Buffer.concat([pending, chunk])` —— pipe 每给 64KB 就拼一次，
   * 一帧 1.03MB 要拼 16 次，累计拷贝 ≈ 8.5MB/帧（100MB/s @12fps），全是白干。
   * 现在先 `allocUnsafe(need)` 再按需 `copy` 进来，一帧固定 1MB。
   */
  let acc = null;
  let filled = 0;
  let n = 0;
  const t0 = Date.now();
  let err = '';
  // 暂停：停止读 stdout，让 ffmpeg 的管道写满后自然背压，进程不退出。
  let paused = false;

  const deliver = (buf) => {
    const i = n;
    n += 1;
    if (i === 0) onFirst?.(Date.now() - t0);
    onFrame?.({ i, t: Number(baseSec || 0) + i / fps, buf });
  };

  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (paused) return;
      let off = 0;
      while (off < chunk.length) {
        // `filled` 填满就立刻交付并清零，所以这里 room 永远 > 0
        const room = need - filled;
        const take = chunk.length - off < room ? chunk.length - off : room;
        if (filled === 0 && take === need) {
          // 整帧刚好落在一个 chunk 里：零拷贝，直接给视图
          deliver(chunk.subarray(off, off + need));
          off += need;
          continue;
        }
        if (filled === 0) acc = Buffer.allocUnsafe(need);
        chunk.copy(acc, filled, off, off + take);
        filled += take;
        off += take;
        if (filled === need) { deliver(acc); acc = null; filled = 0; }
      }
    });
    child.stderr.on('data', (d) => {
      err = `${err}${d}`.slice(-4000);
      onStderr?.(String(d));
    });
    child.on('error', (e) => {
      // 常见于 ffmpeg 不在 PATH（ENOENT）—— 分类后上层能直接给出"装/指路径"的提示
      e.errorInfo = captureErrorInfo(e, 'spawn');
      reject(e);
    });
    child.on('close', (code) => {
      const secs = Math.round((Date.now() - t0) / 1000);
      // `code === null` = 被我们自己 SIGKILL 的（stop / 换清晰度 / 收工）。
      // 那是正常收尾，不是失败 —— 否则每次 stop 都往 lastError 里写一条假错误。
      if (code === null) {
        resolve({ frames: n, ms: Date.now() - t0, code });
        return;
      }
      /**
       * 屏幕采集**不存在"自然播完"**：源是活的屏幕，ffmpeg 只会在出错或源消失时自己退出。
       * 所以 code 非 0 一律是异常；code === 0 也不是收工（以前这里会静默 resolve，
       * 于是"采集中途停了"在上层看来跟正常停止一模一样，社区报的那种 141s/177s 中途退出
       * 就查不出原因）。
       *
       * 报错里必须带**跑了多久、收了多少帧** —— 只有 code 是定位不了的：
       * 12fps 下 141s/1686 帧说明是正常跑着跑着停的，而不是启动就崩。
       */
      const stderrTail = err.trim().slice(-1000) || null;
      /**
       * **文件源是有限的：放完就 code 0，那是正常收尾。**
       *
       * 这条以前缺失，后果不是"多一条日志"—— `runner` 的 `run.done.then()` 里才写
       * `endedSource`，走 reject 分支的话那个硬闸永远不生效，下一次 `watch` 会把
       * 同一个文件**从头再放一遍**（社区实报：24 秒解 1955 帧、刷几十张图、
       * 反复叫醒、关窗也停不干净）。`scripts/sim.mjs` 也因此在最后一步抛异常。
       */
      if (code === 0 && source?.kind === 'file') {
        resolve({ frames: n, ms: Date.now() - t0, code, ended: true });
        return;
      }
      if (code !== 0) {
        const error = new Error(`ffmpeg exit ${code}（运行 ${secs}s / ${n} 帧）`
          + `: ${err.trim().slice(-300) || '无 stderr'}`);
        error.code = code;
        error.stderrTail = stderrTail;
        error.errorInfo = captureErrorInfo(error, 'exit');
        const hint = CAPTURE_HINTS[error.errorInfo.category];
        if (hint) error.message += `\n  ↳ ${hint}`;
        reject(error);
        return;
      }
      const error = new Error(`ffmpeg 自己退出了（code 0，运行 ${secs}s / ${n} 帧）—— `
        + `屏幕源没了？独占全屏切换 / 显示器休眠 / 抓屏引擎掉线都会这样。`
        + ` stderr: ${err.trim().slice(-300) || '空'}`);
      error.stderrTail = stderrTail;
      error.errorInfo = captureErrorInfo(error, 'exit');
      reject(error);
    });
  });

  return {
    done,
    /** 暂停解码：不再读 stdout，ffmpeg 写满管道后自然背压，进程保持存活。 */
    pause() {
      if (paused) return;
      paused = true;
      child.stdout.pause();
    },
    /** 继续解码：先消费暂停期间缓冲的字节，再恢复流。 */
    resume() {
      if (!paused) return;
      paused = false;
      child.stdout.resume();
    },
    get paused() { return paused; },
    stop() {
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    },
  };
}

/* ---------------------------------------------------------------- 引擎探测 */

/**
 * 屏幕源用哪个引擎 —— **测一次、整个进程记住**。
 *
 * 为什么需要探测（Windows）：`ddagrab` 走桌面复制 API，独占全屏的游戏 / 部分远程桌面会把它挡住
 * （报 "Selected output not supported" 或者干脆不吐帧）。那种情况下不能哑着 ——
 * 退到 `gdigrab` 只是多花 0.17 核，画面照样能看。
 *
 * 代价是进程里第一次开屏幕要多 spawn 一次 ffmpeg（~400ms）。所以结果缓存，
 * 之后每次 start 都是 0 成本；本机这两种引擎的可用性不会在一次会话里变。
 *
 * macOS 没有备选引擎，但探针**仍然要跑**：它顺带替我们回答"屏幕录制权限给了没"。
 * 没权限的时候 ffmpeg 照样 exit 0、照样吐帧，只是全黑 —— 只有看平均像素才知道。
 */
let cachedEngine = null;
let cachedFormat = null;            // macOS 屏幕像素格式：'' = 用设备默认
let screenWarning = null;
/**
 * ddagrab 探测出来的 DXGI output 序号。`null` = 用 ffmpeg 的默认值（0），
 * 此时命令行与以前**逐字节一致** —— 正常机器上不允许因为这次改动多出参数。
 */
let cachedOutputIdx = null;

export function resetScreenEngineCache() {
  cachedEngine = null;
  cachedFormat = null;
  screenWarning = null;
  cachedOutputIdx = null;
}

/** 上一次探测留下的警告（目前只有"没有屏幕录制权限"这一类）。 */
export function screenEngineWarning() {
  return screenWarning;
}

/** 抽样求均值就够了，不用全量遍历 6912 字节 × 每帧。 */
function meanOf(buf) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 97) {
    sum += buf[i];
    n += 1;
  }
  return n ? sum / n : 0;
}

export function pickScreenEngine({
  ffmpegPath = 'ffmpeg', fps = 12, timeoutMs = 2500, platform = process.platform,
} = {}) {
  if (cachedEngine) return Promise.resolve(cachedEngine);
  if (platform === 'darwin') return probeAvfoundation({ ffmpegPath, fps, timeoutMs });
  if (platform !== 'win32') {
    return Promise.reject(new RangeError(
      `屏幕采集还没接 ${platform}：Windows 走 ddagrab/gdigrab，macOS 走 avfoundation，Linux 需要 x11grab 或 PipeWire，还没做。`,
    ));
  }
  return probeDdagrab({ ffmpegPath, fps, timeoutMs });
}

/** macOS：探一次 avfoundation，同时判黑屏（= 没权限）。 */
/**
 * macOS：探一次 avfoundation —— 一次回答三个问题。
 *
 * ① 能不能出帧（ffmpeg 在不在、设备名对不对）；
 * ② **哪个像素格式设备真收**（默认的 yuv420p 屏幕输入不支持，必须自己试）；
 * ③ 画面是不是全黑（= 系统没给「屏幕录制」权限，ffmpeg 自己不会报）。
 *
 * 顺序是**按实测 CPU 从省到费**排的（本机 12fps→800×450：nv12 0.14 核 ≈ uyvy422 0.15 ≈
 * 设备默认 0.14，bgr0 0.23）。格式不对时 ffmpeg 会很快报错退出，所以串行试不会拖慢。
 */
async function probeAvfoundation({ ffmpegPath, fps, timeoutMs }) {
  const W = 64;                      // 探针只取 1 帧，尺寸越小越快
  const H = 36;
  const formats = ['nv12', 'uyvy422', 'bgr0', null];
  for (const pf of formats) {
    const shot = await grabOneFrame({ ffmpegPath, fps, width: W, height: H, pixelFormat: pf, timeoutMs });
    if (!shot.got) continue;
    cachedEngine = 'avfoundation';
    cachedFormat = pf ?? '';
    // 拿到帧但全是黑的 → 有采集会话、没画面，这就是 macOS 的"没权限"的样子。
    screenWarning = meanOf(shot.buf) < 1 ? SCREEN_PERMISSION_HINT : null;
    return 'avfoundation';
  }
  // 一帧都没拿到：启动层面的问题（ffmpeg 不在、设备名不对），留给 start 报错。
  cachedEngine = 'avfoundation';
  cachedFormat = '';
  screenWarning = null;
  return 'avfoundation';
}

/** 单帧探针。拿到满一帧就提前 resolve，不等 close。 */
function grabOneFrame({ ffmpegPath, fps, width, height, pixelFormat, timeoutMs }) {
  const args = captureArgs({
    source: { kind: 'screen', engine: 'avfoundation', pixelFormat: pixelFormat ?? '' },
    width, height, fps, ffmpegPath, engine: 'avfoundation',
  }).slice(1);
  args.splice(args.length - 1, 0, '-frames:v', '1');
  const need = width * height * 3;

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve({ got: buf.length >= need, buf: buf.subarray(0, need) });
    };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= need) { clearTimeout(timer); finish(); }
    });
    child.on('error', () => { clearTimeout(timer); finish(); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
}

/** Windows：探 ddagrab，不行退 gdigrab。 */
/**
 * 探一次 ddagrab。**先按默认参数试，失败才放宽。**
 *
 * 社区那台 GTX1050Ti 报的 `Selected output not supported` 是 ffmpeg 里
 * `DuplicateOutput` 返回 `DXGI_ERROR_UNSUPPORTED` 的分支（见 7.0 的
 * `vsrc_ddagrab.c`：这条 HRESULT 只印这一句；索引越界是另一句
 * `Failed to enumerate DXGI output N`，其它情况是 `access denied` / `Failed duplicating output`）。
 * 换句话说：**那个 output 自己拒绝被复制**，不是编号找错了。
 *
 * 由此得到两条硬约束，别再绕弯：
 *  ① **适配器不能从命令行指定**。`-init_hw_device d3d11va=dx:N -filter_hw_device dx`
 *     对 `-f lavfi` 的输入图**不生效** —— 实测 ddagrab 照样打 "Created internal
 *     hw_device_ctx"（它自己建设备，用的是 libavutil 选的默认适配器）。
 *     所以"混合显卡要换块卡"这条路走不通，只能换 output_idx。
 *  ② output_idx 只能救"这台机器上存在第 N 个 output"的情况。真的是 UNSUPPORTED
 *     （虚拟显示器、被独占全屏挡住、远程会话）时，四档全试也一样失败 —— 那时
 *     gdigrab 不是"降级"，是唯一能出画面的引擎。
 *
 * 尽力而为的部分：先换 output_idx，最后才动 allow_fallback
 * （后者允许 ffmpeg 回退到 8bit 输出，精度略降，但比完全没有 GPU 路径强）。
 *
 * 失败是**快速失败**：ffmpeg 报错立即退出，不会耗满 timeoutMs（本机实测
 * output 1/2/3 各 ~80ms 就返回），所以多试几个不会拖慢启动。
 */
function probeDdagrab({ ffmpegPath, fps, timeoutMs }) {
  const W = 64;
  const H = 36;
  // null = 默认参数，命令行与历史版本逐字节一致
  const attempts = [
    null,
    { outputIdx: 1, allowFallback: true },
    { outputIdx: 2, allowFallback: true },
    { outputIdx: 0, allowFallback: true },
  ];
  const deadline = Date.now() + Math.max(timeoutMs * 2, 6000);

  const tryOne = (extra) => new Promise((resolve) => {
    const args = captureArgs({
      source: { kind: 'screen', engine: 'ddagrab', ...(extra ?? {}) },
      width: W, height: H, fps, ffmpegPath, engine: 'ddagrab',
    }).slice(1);
    args.splice(args.length - 1, 0, '-frames:v', '1');
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve({ ok: false, stderr: '' });
      return;
    }
    let got = 0;
    let settled = false;
    let stderr = '';
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve({ ok, stderr });
    }
    child.stdout.on('data', (d) => {
      got += d.length;
      if (got >= W * H * 3) finish(true);
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-400); });
    child.on('error', () => finish(false));
    child.on('close', () => finish(got >= W * H * 3));
  });

  return (async () => {
    let firstError = '';
    for (const extra of attempts) {
      if (Date.now() > deadline) break;
      const r = await tryOne(extra);
      if (r.ok) {
        cachedEngine = 'ddagrab';
        cachedOutputIdx = extra?.outputIdx ?? null;
        // 走放宽路径才成功 → 说清楚，别让人以为一切正常
        if (extra) {
          screenWarning = `GPU 抓屏（ddagrab）在默认输出上起不来，已改用 output_idx=${extra.outputIdx}`
            + `${extra.allowFallback ? '（允许 8bit 回退）' : ''} —— 这通常是混合显卡笔记本，屏幕挂在另一块显卡上。`;
        }
        return 'ddagrab';
      }
      if (!firstError) firstError = r.stderr;
    }
    cachedEngine = 'gdigrab';
    cachedOutputIdx = null;
    screenWarning = ddagrabFallbackHint(firstError);
    return 'gdigrab';
  })();
}

/** ddagrab 彻底不可用时给一句人话，而不是让用户对着"卡"猜。 */
function ddagrabFallbackHint(stderr) {
  const line = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /not supported|Failed|Error|error/i.test(l)) ?? '';
  const why = line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 100);
  return `GPU 抓屏（ddagrab）不可用${why ? `：${why}` : ''}，已退到 gdigrab。`
    + '后者每帧要从 GDI 拷整屏，全屏 12fps 很吃 CPU，放视频可能卡 —— 可以降低 quality 档或先关掉。';
}
