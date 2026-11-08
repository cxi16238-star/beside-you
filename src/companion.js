/**
 * companion.js — 带一个 Python 常驻小进程，拿全局快捷键和前台窗口。
 *
 * 为什么要这么一个进程，见 `examples/floating-chat/companion.py` 开头；这里只说
 * **Node 这一侧的责任**三点：
 *
 * 1. **它是可选的**。没设快捷键、没开"焦点暂停"的时候，这个进程**根本不该起来** ——
 *    一个为了两个用不上的功能常驻的轮询器，是纯负担。
 * 2. **它不能把插件弄挂**。解释器没有、脚本起不来、进程崩了 —— 全部变成一句
 *    能显示在设置页里的 `reason`，绝不抛。
 * 3. **配置热生效**。改了快捷键/焦点开关走 stdin 一条命令即可，不用重载插件、
 *    更不用重启 DSH（"改个快捷键要重开编辑器"是不能接受的）。
 *
 * 状态机：`off`（不需要）→ `starting`（找解释器）→ `running`；出问题进 `error`
 * 并带 `reason`；平台不支持是 `unsupported`（两者在设置页里的措辞不一样：
 * 一个是"这台机器怎么了"，一个是"这个系统暂时没有"）。
 *
 * @module src/companion.js
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonCandidates } from './window.js';
import { hotkeyText } from './hotkeys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGED = join(HERE, '..', 'examples', 'floating-chat', 'companion.py');

/** 进程挂了之后还试几次。3 次足够跨过"解释器被杀/更新"这种瞬时状态。 */
const RESTART_LIMIT = 3;
const RESTART_DELAYS_MS = [1000, 5000, 15000];

/**
 * 找脚本。和悬浮窗不同，这里**不跟随 watch-together 的安装副本** —— 伴生进程
 * 和 `hotkeys.js` 的协议是一起改的，混用另一个仓库里的老脚本必然对不上字段。
 */
export function resolveCompanionScript({ env = process.env } = {}) {
  const explicit = env.DSH_SEE_COMPANION;
  if (explicit && existsSync(explicit)) return { script: explicit, from: 'DSH_SEE_COMPANION' };
  if (existsSync(PACKAGED)) return { script: PACKAGED, from: '包内' };
  return { script: null, from: null };
}

/**
 * 探针：只要 Python ≥ 3.8，**不要 tkinter**。
 *
 * 悬浮窗那个探针要求 tkinter 是对的（窗是 Tk 画的），但伴生进程只用 ctypes ——
 * 拿 tkinter 去筛会把"Python 装得好好的但没装 Tk"的机器误判成不可用。
 */
const PY_MIN = [3, 8];
const PY_PROBE = 'import sys\nraise SystemExit(0 if sys.version_info >= (3, 8) else 3)';

function probePython(python) {
  // `stdio` 抄 window.js 的 `pythonProbe`：不要它的 stdout（那里只会是版本号或垃圾），
  // 但留着 stderr —— "ImportError: ..." 是这类失败唯一有用的信息。
  const r = spawnSync(python, ['-c', PY_PROBE], {
    timeout: 8000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r?.error) return `跑不起来：${r.error.code ?? r.error.message}`;
  if (r?.status === 0) return null;
  if (r?.status === 3) return `版本太低（要 ≥ ${PY_MIN.join('.')}）`;
  const tail = String(r?.stderr ?? '').trim().split('\n').pop();
  return tail ? `探针退出码 ${r?.status}：${tail.slice(0, 200)}` : `探针退出码 ${r?.status}`;
}

/** 一行一个 JSON。单行坏了跳过 —— 不该因为一条脏输出把整条通道判死。 */
function makeLineReader(onObject) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') onObject(obj);
      } catch {
        /* 不是 JSON 就丢掉：Python 那边偶尔会漏一行 traceback 到 stdout */
      }
    }
    // 防止没有换行的流氓输出把内存撑爆
    if (buf.length > 65536) buf = '';
  };
}

/**
 * @param {object} o
 * @param {(event:{keys:string[]}) => void} [o.onHotkey] 用户按下快捷键（上升沿，只报一次）
 * @param {(event:{keys:string[]}) => void} [o.onMicHotkey] 用户按下麦克风快捷键（点按切换录音）
 * @param {(event:{keys:string[]}) => void} [o.onInputHotkey] 用户按下输入条快捷键（唤起/收起输入条）
 * @param {(event:{focused:boolean}) => void} [o.onFocus] 前台窗口换成/换离 DSH
 * @param {string} [o.appExe] 要认作"DSH"的可执行文件；默认当前进程的 exe
 * @param {boolean} [o.supportsFocus] 宿主是不是桌面窗口（web 版没有"DSH 窗口"可认）
 * @param {(line:string) => void} [o.log]
 */
export function createCompanion({
  env = process.env,
  onHotkey = () => {},
  onMicHotkey = () => {},
  onInputHotkey = () => {},
  onFocus = () => {},
  appExe = process.execPath,
  supportsFocus = Boolean(process.versions?.electron),
  log = () => {},
} = {}) {
  const state = {
    status: 'off',
    reason: null,
    hotkey: [],
    micHotkey: [],
    inputHotkey: [],
    focus: false,
    python: null,
    restarts: 0,
  };

  let child = null;
  let childExited = true;
  let wanted = { hotkey: [], micHotkey: [], inputHotkey: [], focus: false };
  let startPromise = null;
  let restartTimer = null;
  let quitRequested = false;

  const needRun = () => wanted.hotkey.length > 0 || wanted.micHotkey.length > 0
    || wanted.inputHotkey.length > 0 || (wanted.focus && supportsFocus);

  function setStatus(status, reason = null) {
    state.status = status;
    state.reason = reason;
  }

  /** 把所有失败都变成 `setStatus('error', 人话)`。 */
  function fail(reason) {
    setStatus('error', reason);
    log(`[伴生进程] ${reason}`);
  }

  async function pickPython() {
    if (state.python && !probePython(state.python)) return state.python;
    const tried = [];
    for (const candidate of pythonCandidates()) {
      const bad = probePython(candidate);
      if (bad === null) {
        state.python = candidate;
        return candidate;
      }
      tried.push(`${candidate}（${bad}）`);
    }
    fail(`找不到能用的 Python（要 ≥ ${PY_MIN.join('.')}，不需要 tkinter）。试过：${tried.join('、') || '（没有候选）'}`
      + '。设置环境变量 DSH_SEE_PYTHON 指向一个解释器，或者关掉快捷键与焦点暂停。');
    return null;
  }

  function sendConfig() {
    if (!child || childExited || !child.stdin?.writable) return;
    const payload = {
      hotkey: wanted.hotkey,
      micHotkey: wanted.micHotkey,
      inputHotkey: wanted.inputHotkey,
      focus: Boolean(wanted.focus && supportsFocus),
    };
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      state.hotkey = wanted.hotkey;
      state.micHotkey = wanted.micHotkey;
      state.inputHotkey = wanted.inputHotkey;
      state.focus = payload.focus;
    } catch (err) {
      log(`[伴生进程] 下发配置失败：${err?.message ?? err}`);
    }
  }

  async function start() {
    if (startPromise) return startPromise;
    if (!needRun()) {
      setStatus('off');
      return null;
    }
    if (process.platform !== 'win32') {
      setStatus('unsupported', '全局快捷键和前台窗口检测目前只支持 Windows；陪看本身不受影响。');
      return null;
    }
    if (wanted.focus && !supportsFocus) {
      // 说清楚：不是坏了，是"web 打开的那份 DSH 没有窗口可认"
      setStatus('error', '当前宿主不是桌面窗口（web 版），没有"DSH 获得焦点"这件事；'
        + '焦点暂停不可用，快捷键仍然有效。');
      if (!wanted.hotkey.length) return null;
    }

    const { script } = resolveCompanionScript({ env });
    if (!script) {
      fail('找不到 examples/floating-chat/companion.py（包不完整？）');
      return null;
    }

    startPromise = (async () => {
      setStatus('starting');
      const python = await pickPython();
      if (!python) return null;
      if (!needRun()) { setStatus('off'); return null; }  // 探测期间用户又关掉了

      const args = [script];
      if (appExe) args.push('--app-exe', appExe);
      if (wanted.hotkey.length) args.push('--hotkey', hotkeyText(wanted.hotkey));
      if (wanted.micHotkey.length) args.push('--mic-hotkey', hotkeyText(wanted.micHotkey));
      if (wanted.inputHotkey.length) args.push('--input-hotkey', hotkeyText(wanted.inputHotkey));
      if (wanted.focus && supportsFocus) args.push('--focus');

      let proc;
      try {
        proc = spawn(python, args, {
          // 三个管道全开：stdin 下发配置、stdout 收事件、stderr 收 traceback
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
      } catch (err) {
        fail(`起不来（${err?.code ?? err?.message ?? err}）：${python} ${script}`);
        return null;
      }

      child = proc;
      childExited = false;
      quitRequested = false;
      state.hotkey = wanted.hotkey;
      state.micHotkey = wanted.micHotkey;
      state.inputHotkey = wanted.inputHotkey;
      state.focus = Boolean(wanted.focus && supportsFocus);

      const onLine = makeLineReader((obj) => {
        if (obj.t === 'ready') {
          setStatus('running');
          state.restarts = 0;
          // ready 之后下发的这份是**权威配置**：命令行参数可能被平台过滤，这里补一刀
          sendConfig();
        } else if (obj.t === 'hotkey') {
          onHotkey({ keys: Array.isArray(obj.keys) ? obj.keys.map(String) : [] });
        } else if (obj.t === 'mic-hotkey') {
          onMicHotkey({ keys: Array.isArray(obj.keys) ? obj.keys.map(String) : [] });
        } else if (obj.t === 'input-hotkey') {
          onInputHotkey({ keys: Array.isArray(obj.keys) ? obj.keys.map(String) : [] });
        } else if (obj.t === 'focus') {
          onFocus({ focused: Boolean(obj.focused) });
        } else if (obj.t === 'error') {
          fail(String(obj.error ?? '伴生进程报错（没给原因）'));
        }
      });

      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk) => onLine(String(chunk)));
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) log(`[伴生进程 stderr] ${text.slice(0, 800)}`);
      });

      proc.on('error', (err) => {
        childExited = true;
        fail(`spawn 失败（${err?.code ?? err?.message ?? err}）`);
      });

      proc.on('exit', (code, signal) => {
        childExited = true;
        child = null;
        if (quitRequested) {
          setStatus('off');
          return;
        }
        // 自己报过错就别再反复重启了 —— 那是"这台机器上没有"，不是"崩了一下"
        if (state.status === 'error') return;
        if (!needRun()) {
          setStatus('off');
          return;
        }
        state.restarts += 1;
        if (state.restarts > RESTART_LIMIT) {
          fail(`伴生进程反复退出（最后一次 code=${code} signal=${signal}），不再重启。`);
          return;
        }
        setStatus('starting', `伴生进程退出了（code=${code}），第 ${state.restarts} 次重试…`);
        const delay = RESTART_DELAYS_MS[Math.min(state.restarts, RESTART_DELAYS_MS.length) - 1];
        restartTimer = setTimeout(() => {
          restartTimer = null;
          void start();
        }, delay);
      });

      // 起来之后 800ms 还没 ready 就是"起来了但没说话"，同样按错误处理
      setTimeout(() => {
        if (state.status === 'starting' && !childExited) {
          log('[伴生进程] 800ms 内没有 ready，先不动它（可能是解释器启动慢）');
        }
      }, 800);
      return proc;
    })();

    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  /** 优雅收工：先请它自己退，2s 不退就杀。**这条路径不许抛**。 */
  function stop() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (!child || childExited) {
      if (state.status !== 'error' && state.status !== 'unsupported') setStatus('off');
      return;
    }
    quitRequested = true;
    const proc = child;
    try {
      proc.stdin?.write('{"quit":true}\n');
      proc.stdin?.end();
    } catch {
      /* 管道已经断了就是已经退了 */
    }
    setTimeout(() => {
      if (!childExited) {
        try { proc.kill(); } catch { /* 已经没了 */ }
      }
    }, 2000).unref?.();
  }

  /**
   * 换配置。**唯一入口** —— 挂载时、设置页保存后都走这里。
   *
   * @param {{hotkey?:string[], micHotkey?:string[], inputHotkey?:string[], focus?:boolean}} next
   */
  function setConfig(next = {}) {
    if (Array.isArray(next.hotkey)) wanted.hotkey = next.hotkey.map(String);
    if (Array.isArray(next.micHotkey)) wanted.micHotkey = next.micHotkey.map(String);
    if (Array.isArray(next.inputHotkey)) wanted.inputHotkey = next.inputHotkey.map(String);
    if (typeof next.focus === 'boolean') wanted.focus = next.focus;

    if (!needRun()) {
      stop();
      setStatus('off');
      return;
    }
    if (state.status === 'running' && !childExited) {
      sendConfig();      // 热生效，不动进程
      return;
    }
    if (state.status === 'unsupported') {
      // 平台不支持：不要再起一次（每次保存设置都 spawn 一次失败毫无意义）
      return;
    }
    void start();
  }

  /** 给设置页看的一行状态。字段名保持"人话优先"，界面直接摊开。 */
  function status() {
    return {
      status: state.status,
      reason: state.reason,
      hotkey: [...state.hotkey],
      micHotkey: [...state.micHotkey],
      inputHotkey: [...state.inputHotkey],
      focus: state.focus,
      python: state.python,
      platform: process.platform,
      supportsFocus,
      // 界面用它决定勾选框要不要灰掉
      canFocus: supportsFocus && process.platform === 'win32',
      canHotkey: process.platform === 'win32',
    };
  }

  return { setConfig, status, stop, restart: () => { stop(); void start(); } };
}
