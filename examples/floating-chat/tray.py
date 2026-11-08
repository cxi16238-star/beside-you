#!/usr/bin/env python3
"""托盘图标：窗口"最小化到底下"之后，用户唯一能点回来的地方。

**为什么必须有它**：`overrideredirect(True)` 的窗口不会出现在任务栏，`withdraw()`
之后屏幕上一点痕迹都没有 —— 没有托盘就等于"窗口没了，只能杀进程"。用户的诉求是
"像网页那样缩到底下"，网页缩下去还有任务栏按钮可点，这里对应的就是托盘图标。

零新依赖：`Shell_NotifyIconW` 走 ctypes，图标从仓库里的 `mic-dsh.png` 转一张 ico
缓存到 cache 目录。

**为什么消息循环在子线程**：在 Tk 主线程里用 `PeekMessage` 泵自己的窗口消息，
会撞上 Tk 自己的泵；更糟的是主线程的 ctypes 回调链里 `DefWindowProcW` 会释放 GIL，
回来时线程状态是 NULL —— 实测直接 `Fatal Python error: PyEval_RestoreThread`。
所以：子线程建窗口 + `GetMessage` 循环 + 回调只往 `queue` 里塞，主线程用
`root.after` 消费（Tk 只能在主线程碰）。回调本身从不直接操作窗口。
"""
from __future__ import annotations

import ctypes
import os
import queue
import threading
from ctypes import wintypes

IS_WIN = os.name == "nt"

WM_APP = 0x8000
WM_TRAY = WM_APP + 1
WM_QUIT = 0x0012
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205

NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_SHOWTIP = 0x1, 0x2, 0x4, 0x80
NIF_INFO = 0x10

HWND_MESSAGE = -3
IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
IDI_APPLICATION = 32512
POLL_MS = 150

if IS_WIN:
    from ctypes import WINFUNCTYPE

    LRESULT = ctypes.c_ssize_t
    WNDPROC = WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT,
                          wintypes.WPARAM, wintypes.LPARAM)

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [("style", wintypes.UINT),
                    ("lpfnWndProc", WNDPROC),
                    ("cbClsExtra", ctypes.c_int),
                    ("cbWndExtra", ctypes.c_int),
                    ("hInstance", wintypes.HINSTANCE),
                    ("hIcon", wintypes.HICON),
                    ("hCursor", wintypes.HANDLE),
                    ("hbrBackground", wintypes.HBRUSH),
                    ("lpszMenuName", wintypes.LPCWSTR),
                    ("lpszClassName", wintypes.LPCWSTR)]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD),
                    ("hWnd", wintypes.HWND),
                    ("uID", wintypes.UINT),
                    ("uFlags", wintypes.UINT),
                    ("uCallbackMessage", wintypes.UINT),
                    ("hIcon", wintypes.HICON),
                    ("szTip", wintypes.WCHAR * 128),
                    ("dwState", wintypes.DWORD),
                    ("dwStateMask", wintypes.DWORD),
                    ("szInfo", wintypes.WCHAR * 256),
                    ("uVersion", wintypes.UINT),
                    ("szInfoTitle", wintypes.WCHAR * 64),
                    ("dwInfoFlags", wintypes.DWORD),
                    ("guidItem", ctypes.c_byte * 16),
                    ("hBalloonIcon", wintypes.HICON)]


def _ico_path(cache_dir, png_path) -> str:
    """PNG → ICO，落在 cache 里（失败返回空串，退化成系统图标）。"""
    try:
        from pathlib import Path
        from PIL import Image
        png = Path(png_path)
        if not png.exists():
            return ""
        out = Path(cache_dir) / "dsh-tray.ico"
        if out.exists() and out.stat().st_mtime >= png.stat().st_mtime:
            return str(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        Image.open(png).convert("RGBA").save(
            out, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48)])
        return str(out)
    except Exception:
        return ""


class TrayIcon:
    """一个图标 + 左键回主窗。没图标（非 Windows / 加载失败）时全部空转。"""

    def __init__(self, root, *, tip="陪看 · 点击展开", icon_png=None,
                 cache_dir=None, on_activate=None):
        self.root = root
        self.tip = str(tip)[:120]
        self.on_activate = on_activate
        self.available = False
        self._visible = False
        self._hwnd = None
        self._tid = None
        self._job = None
        self._wndproc = None       # 必须留引用：被 GC 掉 = 回调直接崩
        self._hicon = None
        self._q = queue.Queue()
        self._ready = threading.Event()
        self._thread = None
        if not IS_WIN:
            return
        try:
            self._u = ctypes.windll.user32
            self._shell = ctypes.windll.shell32
            self._k32 = ctypes.windll.kernel32
            # **每个吃指针/句柄的函数都必须设 argtypes**：不设的话 ctypes 按 c_int
            # 传（32 位），64 位下 hInstance / hwnd 会被截断 —— 表现就是
            # "窗口建起来了，跑一会儿 Segmentation fault"，因为消息分发踩到了
            # 别的模块地址（本机实测 2m44s 后崩）。
            self._k32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
            self._k32.GetModuleHandleW.restype = wintypes.HMODULE
            self._k32.GetCurrentThreadId.restype = wintypes.DWORD
            self._u.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT,
                                               wintypes.WPARAM, wintypes.LPARAM]
            self._u.DefWindowProcW.restype = ctypes.c_ssize_t
            self._u.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
            self._u.RegisterClassW.restype = wintypes.ATOM
            self._u.CreateWindowExW.argtypes = [
                wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
            self._u.CreateWindowExW.restype = wintypes.HWND
            self._u.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG),
                                            wintypes.HWND, wintypes.UINT, wintypes.UINT]
            self._u.GetMessageW.restype = ctypes.c_int
            self._u.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT,
                                                   wintypes.WPARAM, wintypes.LPARAM]
            self._u.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR,
                                           wintypes.UINT, ctypes.c_int, ctypes.c_int,
                                           wintypes.UINT]
            self._u.LoadImageW.restype = wintypes.HANDLE
            self._u.LoadIconW.argtypes = [wintypes.HINSTANCE, wintypes.LPVOID]
            self._u.LoadIconW.restype = wintypes.HICON
            self._shell.Shell_NotifyIconW.argtypes = [wintypes.DWORD,
                                                      ctypes.POINTER(NOTIFYICONDATAW)]
            self._shell.Shell_NotifyIconW.restype = wintypes.BOOL
            self._hinst = self._k32.GetModuleHandleW(None)
            self._hicon = self._load_icon(icon_png, cache_dir)
            self._thread = threading.Thread(target=self._run, name="dsh-tray",
                                            daemon=True)
            self._thread.start()
            if not self._ready.wait(2.0):
                raise OSError("tray window not ready")
            self.available = True
        except Exception as exc:
            print("tray init failed", repr(exc), flush=True)
            self.available = False

    # ---- 子线程：建窗口 + 消息循环 ----

    def _run(self) -> None:
        u = self._u
        # 类名带 pid：同名类第二次注册会失败（1410），而 `CreateWindowEx` 还是会
        # 成功 —— 但它挂的是**上一个实例**的 WNDPROC，那个回调早就被回收了。
        # 消息一到就是跳进野指针（段错误）。
        cls_name = "DshFloatTrayWnd_%d" % os.getpid()

        def proc(hwnd, msg, wparam, lparam):
            if msg == WM_TRAY:
                # 只往队列里塞，绝不碰 Tk（这里不是主线程）
                self._q.put(int(lparam) & 0xFFFF)
            return u.DefWindowProcW(hwnd, msg, wparam, lparam)

        try:
            self._wndproc = WNDPROC(proc)
            wc = WNDCLASSW()
            wc.style = 0
            wc.lpfnWndProc = self._wndproc
            wc.cbClsExtra = 0
            wc.cbWndExtra = 0
            wc.hInstance = self._hinst
            wc.hIcon = 0
            wc.hCursor = 0
            wc.hbrBackground = 0
            wc.lpszMenuName = None
            wc.lpszClassName = cls_name
            u.RegisterClassW(ctypes.byref(wc))
            # 字符串必须显式 c_wchar_p：没 argtypes 时 ctypes 会按 bytes 传，
            # 窗口类名变成乱码 → CreateWindowEx 返回 0。
            self._hwnd = u.CreateWindowExW(
                0, ctypes.c_wchar_p(cls_name), ctypes.c_wchar_p(cls_name), 0,
                0, 0, 0, 0, wintypes.HWND(HWND_MESSAGE), 0, self._hinst, 0)
            if not self._hwnd:
                raise OSError("CreateWindowEx failed: %s" % ctypes.GetLastError())
            self._tid = self._k32.GetCurrentThreadId()
        except Exception as exc:
            print("tray window failed", repr(exc), flush=True)
            self._ready.set()
            return

        self._ready.set()
        msg = wintypes.MSG()
        try:
            while True:
                got = u.GetMessageW(ctypes.byref(msg), 0, 0, 0)
                if got <= 0:          # 0 = WM_QUIT，-1 = 出错
                    break
                u.TranslateMessage(ctypes.byref(msg))
                u.DispatchMessageW(ctypes.byref(msg))
        except Exception as exc:
            print("tray loop ended", repr(exc), flush=True)

    def _load_icon(self, png, cache_dir):
        path = _ico_path(cache_dir, png) if png and cache_dir else ""
        if path:
            h = self._u.LoadImageW(0, path, IMAGE_ICON, 32, 32, LR_LOADFROMFILE)
            if h:
                return h
        # IDI_APPLICATION 是 MAKEINTRESOURCE，不是指针：必须包成 c_void_p 传
        return self._u.LoadIconW(0, ctypes.c_void_p(IDI_APPLICATION))

    # ---- 显隐（主线程）----

    def _data(self):
        d = NOTIFYICONDATAW()
        d.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        d.hWnd = self._hwnd
        d.uID = 1
        d.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP
        d.uCallbackMessage = WM_TRAY
        d.hIcon = self._hicon
        d.szTip = self.tip
        return d

    def _notify_icon(self, action: int, d=None) -> bool:
        """统一入口。

        ⚠️ **结构体必须是活的局部变量**。`ctypes.addressof(self._data())` 拿到的
        是临时对象的地址，表达式一结束对象就被回收 —— `Shell_NotifyIconW` 读的是
        已释放内存（这种代码不报错，直接段错误）。`byref` 会把引用握到调用结束。
        """
        if d is None:
            d = self._data()
        return bool(self._shell.Shell_NotifyIconW(action, ctypes.byref(d)))

    def show(self) -> None:
        if not self.available or self._visible:
            return
        try:
            ok = self._notify_icon(NIM_ADD)
            self._visible = ok
            if not ok:
                print("tray add failed", ctypes.GetLastError(), flush=True)
                return
            self._ensure_polling()
        except Exception as exc:
            print("tray add failed", repr(exc), flush=True)

    def hide(self) -> None:
        if not self.available or not self._visible:
            return
        try:
            self._notify_icon(NIM_DELETE)
        except Exception:
            pass
        self._visible = False

    def set_tip(self, tip: str) -> None:
        self.tip = str(tip)[:120]
        if not self.available or not self._visible:
            return
        try:
            self._notify_icon(NIM_MODIFY)
        except Exception:
            pass

    def notify(self, text: str, title: str = "陪看") -> None:
        """最小化后弹一次系统通知。

        Windows 11 默认把新图标丢进溢出区（要点 ^ 才看得见），只给一个图标
        等于没提示；这条通知是告诉用户"东西还在、在哪"的唯一机会。
        """
        if not self.available or not self._visible:
            return
        try:
            d = self._data()
            d.uFlags |= NIF_INFO
            d.dwInfoFlags = 1          # NIIF_INFO
            d.szInfoTitle = str(title)[:60]
            d.szInfo = str(text)[:250]
            self._notify_icon(NIM_MODIFY, d)
        except Exception:
            pass

    # ---- 主线程：消费回调队列 ----

    def _ensure_polling(self) -> None:
        if self._job is not None or not self.available:
            return
        try:
            self._job = self.root.after(POLL_MS, self._poll)
        except Exception:
            self._job = None

    def _poll(self) -> None:
        self._job = None
        while True:
            try:
                kind = self._q.get_nowait()
            except queue.Empty:
                break
            if kind in (WM_LBUTTONUP, WM_LBUTTONDBLCLK) and self.on_activate:
                try:
                    self.on_activate()
                except Exception as exc:
                    print("tray activate failed", repr(exc), flush=True)
        if not self.available:
            return
        try:
            self._job = self.root.after(POLL_MS, self._poll)
        except Exception:
            self._job = None

    def close(self) -> None:
        self.hide()
        if self._job is not None:
            try:
                self.root.after_cancel(self._job)
            except Exception:
                pass
            self._job = None
        if self._tid:
            try:
                self._u.PostThreadMessageW(self._tid, WM_QUIT, 0, 0)
            except Exception:
                pass
            self._tid = None
        self.available = False
