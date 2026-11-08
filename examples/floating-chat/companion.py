#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""companion.py — 全局快捷键 + 前台窗口，两件 Node 在 Windows 上做不到的事。

为什么要有这个东西
==================

`dsh-see-now` 是「陪你看屏幕」的：你开着一部剧，它在旁边说话。于是有两个刚需
只有**进程外面**才办得到：

1. **全局快捷键**（`Ctrl+Alt+K` 开/关陪看）。Node 的 `process.stdin` 只拿得到
   写给它自己的按键 —— 用户在播放器里按下的那次它根本看不见。
2. **"DSH 处于焦点就停"**。Node 也没有"哪个窗口现在在前台"这个信息。

Windows 上这两件事都是 `user32.dll` 的两个函数，用 ctypes 就够了，不需要装
任何东西（`npm i robotjs` 那种要预编译二进制的方案是最容易被卡住的）。

**为什么不用 `RegisterHotKey`**：它是一次性注册、被别人占了就失败
（IDE、截图工具、输入法都爱占 `Ctrl+Alt+X` 那一带），而且注册之后**按键会被
从所有应用手里吞掉** —— 用户想用 `Ctrl+Alt+K` 在编辑器里做别的事就做不到了。
所以这里改成**每 30ms 轮询一次键位状态**、只在"从松到按"的上升沿报一次
（`GetAsyncKeyState` 的 0x8000 位）。代价是 30ms 的空转（实测 CPU 占用
不到 0.1%，一整天的电费还不如一次截屏），换来的是"不占用、不冲突、
改了立刻生效"。

协议
====

**stdout**：一行一个 JSON，只往 Node 发，不打印任何别的诊断信息
（混一行人类日志进去，Node 那边就解析失败了）。

    {"t":"ready","protocol":1,"hotkey":["Ctrl","Alt","K"],"focus":true}
    {"t":"hotkey","keys":["Ctrl","Alt","K"]}       # 用户按下了这个组合（边沿）
    {"t":"focus","focused":true}                   # 前台窗口换成了 DSH（或换走了）
    {"t":"error","error":"..."}                    # 起不来 / 平台不支持
    {"t":"pong"}                                   # 对 ping 的回应

**stdin**：一行一个 JSON 命令。

    {"hotkey":["Ctrl","Alt","K"],"focus":true}     # 重配（热生效，不用重启）
    {"quit":true}                                  # 收工
    EOF                                            # 父进程没了 → 退出

**EOF 即退出**是故意的：Node 挂了 / 被杀了，这里的 stdin 立刻关掉，这个进程
跟着走，不会在后台留一个看不见的轮询器。

平台
====

只做 Windows。Linux 的 `XGrabKey` 在 Wayland 下没有等价物，macOS 要
Accessibility 授权（`AXIsProcessTrusted`），两套都是"装了也不一定能用"，
不如如实地说"这个平台暂时没有"，让 Node 侧把它显示在设置页里。
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time

# 和 Node 侧 window.js 的 PROTOCOL_VERSION 是两套东西：那边管悬浮窗，这边管伴生进程。
# 但同样要版本号 —— 字段名一旦改，老进程被沿用会静默地什么都不报。
PROTOCOL = 1

# 轮询节奏。30ms 是"手指按下去到下一次采样"的延迟，人感觉不到；
# 再快纯属浪费电（键盘的重复延迟都在 250ms 量级）。
TICK_SEC = 0.03
# 前台窗口没必要 30ms 查一次 —— 250ms 对"人切了个窗口"完全够。
FOCUS_EVERY_SEC = 0.25


def emit(obj):
    """往 stdout 写一行 JSON。写失败就当父进程没了，直接退。"""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        os._exit(0)


# ---------------------------------------------------------------- Windows 侧

# 通用名 → 虚拟键码。只收 hotkeys.js 里 `NAMED_KEYS` 那批 —— 两边必须能对上，
# 对不上的键 Node 侧根本不会发过来。
_VK = {
    'Space': 0x20, 'Tab': 0x09, 'Enter': 0x0D, 'Esc': 0x1B,
    'Backspace': 0x08, 'Delete': 0x2E, 'Insert': 0x2D,
    'Home': 0x24, 'End': 0x23, 'PageUp': 0x21, 'PageDown': 0x22,
    'Up': 0x26, 'Down': 0x28, 'Left': 0x25, 'Right': 0x27,
    'Minus': 0xBD, 'Equal': 0xBB, 'BracketLeft': 0xDB, 'BracketRight': 0xDD,
    'Backslash': 0xDC, 'Semicolon': 0xBA, 'Quote': 0xDE,
    'Comma': 0xBC, 'Period': 0xBE, 'Slash': 0xBF, 'Backquote': 0xC0,
}

# 左右各有一个键，只要有一个按着就算按着 —— 用户不会去想"我按的是左边那个 Ctrl"。
_LEFT_RIGHT = {
    'Ctrl': (0x11, 0xA2, 0xA3),
    'Alt': (0x12, 0xA4, 0xA5),
    'Shift': (0x10, 0xA0, 0xA1),
    'Win': (0x5B, 0x5B, 0x5C),
}


def vk_codes(name):
    """一个规范名 → 需要**同时**满足的虚拟键码组（每组内 OR）。"""
    if name in _LEFT_RIGHT:
        return list(_LEFT_RIGHT[name])
    if name in _VK:
        return [_VK[name]]
    text = str(name)
    if len(text) == 1:
        return [ord(text.upper())]  # A–Z、0–9 的虚拟键码就是它们的 ASCII
    if text.startswith('F') and text[1:].isdigit():
        n = int(text[1:])
        if 1 <= n <= 24:
            return [0x70 + n - 1]
    return []


class Win32:
    """把要用到的三个 user32/kernel32 调用包起来。"""

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ctypes = ctypes
        self.wt = wintypes
        self.user32 = ctypes.WinDLL('user32', use_last_error=True)
        self.kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

        self.user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
        self.user32.GetAsyncKeyState.restype = ctypes.c_short

        self.user32.GetForegroundWindow.argtypes = []
        self.user32.GetForegroundWindow.restype = wintypes.HWND

        self.user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user32.GetWindowThreadProcessId.restype = wintypes.DWORD

        self.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel32.OpenProcess.restype = wintypes.HANDLE
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
        ]
        self.kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL

        self._path_of = {}  # pid → 可执行文件路径；进程会复用 pid，但同一个 pid 换 exe 极少见

    def down(self, vk):
        return bool(self.user32.GetAsyncKeyState(int(vk)) & 0x8000)

    def any_down(self, codes):
        return any(self.down(vk) for vk in codes)

    def exe_path(self, pid):
        """pid 的可执行文件全路径；打不开（权限不够 / 进程没了）返回 None。"""
        if pid in self._path_of:
            return self._path_of[pid]
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = self.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return None
        try:
            size = self.wt.DWORD(32768)
            buf = self.ctypes.create_unicode_buffer(size.value)
            ok = self.kernel32.QueryFullProcessImageNameW(handle, 0, buf, self.ctypes.byref(size))
            path = buf.value if ok else None
        finally:
            self.kernel32.CloseHandle(handle)
        if path:
            self._path_of[pid] = path
        return path

    def foreground_pid(self):
        hwnd = self.user32.GetForegroundWindow()
        if not hwnd:
            return None
        pid = self.wt.DWORD(0)
        self.user32.GetWindowThreadProcessId(hwnd, self.ctypes.byref(pid))
        return pid.value or None

    def focused(self, wanted_exe):
        """前台窗口属于 `wanted_exe` 那个可执行文件吗。

        比的是**可执行文件**，不是 pid：Electron 把主进程、渲染进程、utility 各开
        一个进程，pid 每次重启都变；而它们共用同一个 exe。
        """
        pid = self.foreground_pid()
        if not pid:
            return False
        path = self.exe_path(pid)
        if not path:
            return False
        try:
            same = os.path.normcase(os.path.basename(path)) == os.path.normcase(os.path.basename(wanted_exe))
        except Exception:
            same = False
        return same


# ---------------------------------------------------------------- 主循环


def read_stdin(q):
    """一条命令一行。EOF 推一个哨兵让主循环收工。"""
    try:
        for line in sys.stdin:
            text = line.strip()
            if not text:
                continue
            try:
                q.put(json.loads(text))
            except Exception:
                # 单行坏了不该把整个伴生进程弄死：它只是"这一条命令没听懂"
                q.put({'__bad__': text[:120]})
    except Exception:
        pass
    q.put({'__eof__': True})


def parse_args(argv):
    out = {'hotkey': [], 'mic-hotkey': [], 'input-hotkey': [], 'focus': False, 'app-exe': ''}
    i = 0
    while i < len(argv):
        item = argv[i]
        if item.startswith('--'):
            name = item[2:]
            if name == 'focus':
                out['focus'] = True
            elif name in ('hotkey', 'mic-hotkey', 'input-hotkey', 'app-exe') and i + 1 < len(argv):
                i += 1
                value = argv[i]
                if name == 'app-exe':
                    out[name] = value
                else:
                    out[{'mic-hotkey': 'micHotkey', 'input-hotkey': 'inputHotkey'}.get(name, 'hotkey')] \
                        = [k for k in value.split('+') if k]
        i += 1
    return out


def main(argv):
    # 管道默认按本地代码页编码（中文 Windows 上是 GBK），而 Node 侧按 utf-8 解。
    # 不重设的话，一条中文错误信息会变成一串问号 —— 正好是最需要看清楚的时刻。
    for stream in (sys.stdout, sys.stdin):
        try:
            stream.reconfigure(encoding='utf-8')
        except Exception:
            pass

    cfg = parse_args(argv)

    if sys.platform != 'win32':
        emit({
            't': 'error',
            'error': '全局快捷键和前台窗口检测目前只支持 Windows（Linux 的 Wayland 没有等价的全局热键，'
                     'macOS 要额外授权）。陪看本身不受影响。',
        })
        return 2

    win = Win32()
    st = {'vks': [], 'keys': []}
    # 第二组快捷键：麦克风（点按切换录音）。第三组：输入条（唤起/收起）。互不影响。
    mic = {'vks': [], 'keys': []}
    inp = {'vks': [], 'keys': []}

    def apply_config(next_cfg):
        keys = [str(k) for k in (next_cfg.get('hotkey') or [])]
        groups = [vk_codes(k) for k in keys]
        st['keys'] = keys
        # 任何一个键认不出来 → 这条快捷键作废（Node 侧已经校验过一遍，这里是兜底）
        st['vks'] = groups if keys and all(groups) else []
        mkeys = [str(k) for k in (next_cfg.get('micHotkey') or [])]
        mgroups = [vk_codes(k) for k in mkeys]
        mic['keys'] = mkeys
        mic['vks'] = mgroups if mkeys and all(mgroups) else []
        ikeys = [str(k) for k in (next_cfg.get('inputHotkey') or [])]
        igroups = [vk_codes(k) for k in ikeys]
        inp['keys'] = ikeys
        inp['vks'] = igroups if ikeys and all(igroups) else []
        if 'focus' in next_cfg:
            cfg['focus'] = bool(next_cfg['focus'])
        if next_cfg.get('app-exe'):
            cfg['app-exe'] = str(next_cfg['app-exe'])

    apply_config(cfg)

    q = queue.Queue()
    threading.Thread(target=read_stdin, args=(q,), daemon=True).start()

    emit({'t': 'ready', 'protocol': PROTOCOL, 'hotkey': st['keys'],
          'micHotkey': mic['keys'], 'inputHotkey': inp['keys'], 'focus': bool(cfg['focus'])})

    last_hot = False   # 上一拍的"整条组合是否按着"——只在上升沿报
    last_mic = False
    last_inp = False
    last_focus = None
    next_focus_at = 0.0

    while True:
        # ---- 收命令（不阻塞，主循环不能被 stdin 卡住）
        stop = False
        while True:
            try:
                cmd = q.get_nowait()
            except queue.Empty:
                break
            if cmd.get('__eof__') or cmd.get('quit'):
                stop = True
                break
            if '__bad__' in cmd:
                continue
            if 'ping' in cmd:
                emit({'t': 'pong'})
                continue
            apply_config(cmd)
            # 重配之后重新起边沿：否则"正按着的那个键 + 新配置"会在下一拍立刻误报一次
            last_hot = bool(st['vks']) and all(win.any_down(g) for g in st['vks'])
            last_mic = bool(mic['vks']) and all(win.any_down(g) for g in mic['vks'])
            last_inp = bool(inp['vks']) and all(win.any_down(g) for g in inp['vks'])
        if stop:
            return 0

        # ---- 快捷键：整条组合同时按着才算（`Ctrl+K` 在只按 Ctrl 时不该触发）
        if st['vks']:
            now_hot = all(win.any_down(g) for g in st['vks'])
            if now_hot and not last_hot:
                emit({'t': 'hotkey', 'keys': st['keys']})
            last_hot = now_hot
        else:
            last_hot = False

        # ---- 麦克风快捷键：和上面同一条上升沿规则
        if mic['vks']:
            now_mic = all(win.any_down(g) for g in mic['vks'])
            if now_mic and not last_mic:
                emit({'t': 'mic-hotkey', 'keys': mic['keys']})
            last_mic = now_mic
        else:
            last_mic = False

        # ---- 输入条快捷键：同样只报上升沿
        if inp['vks']:
            now_inp = all(win.any_down(g) for g in inp['vks'])
            if now_inp and not last_inp:
                emit({'t': 'input-hotkey', 'keys': inp['keys']})
            last_inp = now_inp
        else:
            last_inp = False

        # ---- 前台窗口：降频查，变了才报
        now = time.monotonic()
        if cfg['focus'] and now >= next_focus_at:
            next_focus_at = now + FOCUS_EVERY_SEC
            value = bool(cfg['app-exe']) and win.focused(cfg['app-exe'])
            if value != last_focus:
                last_focus = value
                emit({'t': 'focus', 'focused': value})
        elif not cfg['focus']:
            last_focus = None

        time.sleep(TICK_SEC)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as err:  # 起不来就说清楚，别静默地什么都不发生
        try:
            emit({'t': 'error', 'error': f'{type(err).__name__}: {err}'})
        finally:
            sys.exit(3)
