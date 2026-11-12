#!/usr/bin/env python3
# ⚠️ 本文件由 dsh-see-now/scripts/sync-window.mjs 生成，请勿手改（要改请改上游 dsh-watch-together）
"""陪看悬浮窗：不铺全屏背景图，实时抓窗口背后的桌面并模糊成液态玻璃。

四层，各自不知道对方的实现：

    glass_geometry.py   一套尺寸的全部贴图（不可变，尺寸/形状变了换一个新对象）
    glass_cpu.py        CPU 合成：抓屏 → 模糊 → 边缘折射 → 内框透镜 → 染色 → 色散
    glass_gpu.py        同一件事搬到 GPU（moderngl / OpenGL 3.3+）
    glass_static.py     不吃性能的底板：预生成一张磨砂/纯色，换尺寸才重画
    window.py           这个文件：Tk 窗口、聊天流、文字层、拖动/缩放/折叠/改名

`glass_capture.py` 是两条渲染路径共用的抓屏与运动判定 —— 历史上同一条判断
在 CPU / GPU 各写一份，于是同一个 bug 也要修两遍（#39、#48）。

关键点：
- Windows 10 2004+ 的 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)：让本窗口
  从屏幕捕获里消失，于是抓自己所在区域时抓到的是「背后的桌面」，不会递归。
  代价是远程桌面/录屏/截图里整窗也看不见；用 `glass: solid` 切纯色底板，
  不抓屏、不设 WDA，任何捕获方式都能看到。
- 抓到的背景按需重合成（静止时跳帧），所以是实时模糊，不是静态截图。
- 这不是 DWM Acrylic；Acrylic 需要系统「透明效果」开启，这里是软件实时模糊。

样式预设（`~/.dsh/watch-window.json` 的 `glass`，设置页里可改，改完热切换）：

    live    实时玻璃：抓屏 + 模糊，跟着桌面走。最好看，也最吃 CPU。
    frost   静态磨砂：一张预生成的底板，不抓屏、不逐帧合成 —— 不吃性能。
    solid   纯色底板：远程桌面/录屏兜底，任何捕获方式都看得见。
    auto    不写或写 auto：远程/录屏环境自动用 solid，其余用 live。

渲染后端：默认 CPU。`DSH_GLASS_NATIVE=1` 或 `DSH_GLASS_GPU=1` 走 GPU（只对 live 有效）。
"""
# `X | Y` 形式的注解要这个才在 3.9 上不求值（见 #45：Xcode CLT 自带 3.9 是 mac 上
# 最好拿的一个解释器，不该因为注解写法把它排除掉）。
from __future__ import annotations

import ctypes
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

# 是不是 Windows。**所有 ctypes.windll / wintypes / WDA 都必须先问它**：
# `ctypes.windll` 在 macOS/Linux 上根本不存在，模块顶层摸一下就是
# `AttributeError: module 'ctypes' has no attribute 'windll'`，而且死在依赖预检
# 之前，用户看到的是"启动后 700ms 退出，code=1"（issue #40）。
IS_WIN = os.name == "nt"

# 窗口扩展样式：`noActivate` 用它（点窗不激活，见 `_apply_no_activate`）
GWL_EXSTYLE = -20
WS_EX_NOACTIVATE = 0x08000000

if IS_WIN:
    from ctypes import wintypes

# 必须在 import tkinter / 创建任何窗口之前声明 per-monitor v2 DPI 感知。
if IS_WIN:
    _u = ctypes.windll.user32
    try:
        _u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        _u.SetProcessDpiAwarenessContext.restype = ctypes.c_bool
        _u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        pass

    try:
        ctypes.windll.winmm.timeBeginPeriod(1)
    except Exception:
        pass

# ---------------------------------------------------------------- 依赖预检
#
# 必须在 import mss / numpy / PIL / glass_* **之前**：pythonw 没有控制台，
# 导入失败时 Python 直接退出，用户只看到"窗口没出来"，连一行提示都没有（#76）。
# 这里用 ctypes 弹 MessageBox（不依赖 tkinter —— 它也可能缺），并把原因落盘。

def _missing_deps() -> list:
    missing = []
    for module, package in (("tkinter", "tkinter（Python 安装时勾选 tcl/tk）"),
                            ("mss", "mss"), ("numpy", "numpy"), ("PIL", "pillow")):
        try:
            __import__(module)
        except Exception:
            missing.append(package)
    return missing


def _die_missing(missing: list) -> None:
    log_path = Path.home() / ".dsh" / "watch-window-error.log"
    text = ("悬浮窗启动失败：缺少 " + "、".join(missing) + "\n\n"
            + "装一次就好：\n    pip install pillow numpy mss\n\n"
            + f"详情：{log_path}")
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(text + "\n", encoding="utf-8")
    except Exception:
        pass
    # 弹窗标题跟着"谁拉起的这个窗"走：see-now 的用户看到 dsh-watch-together 会以为装错了包
    try:
        ctypes.windll.user32.MessageBoxW(None, text,
                                         os.environ.get("DSH_WINDOW_BRAND") or "dsh-watch-together", 0x10)
    except Exception:
        print(text, flush=True)
    raise SystemExit(2)


if __name__ == "__main__":
    _missing = _missing_deps()
    if _missing:
        _die_missing(_missing)

import tkinter as tk
from dataclasses import replace

import mss
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageTk

from glass_capture import CaptureSource, MotionTracker
from glass_cpu import CpuRenderer
from glass_geometry import (
    BAR_FRAC, BAR_THICK, BAR_Y, DEFAULT_H, DEFAULT_W, KEY, MESSAGE_SLOTS,
    MIC_SIZE, MINI_GAP, MINI_H, MINI_PANEL_H, MINI_W, MIN_H, MIN_W, MSG_BOTTOM_MARGIN, MSG_TOP,
    SLAB_BOT_H, SLAB_OUT, SLAB_RADIUS, SLAB_TOP_H, Geometry, chat_layout,
    collapsed_height, set_plate_alpha, set_plate_color, shapes_for,
)
from window_widgets import ChatFeed, Fonts, TextLayer

try:  # 悬浮窗接口：插件写 window-events.jsonl，窗口回 window-outbox.jsonl
    from window_protocol import WindowProtocol
except Exception:
    WindowProtocol = None


def _max_fps() -> int:
    """目标帧率上限，默认 60；120Hz 玻璃可显式开回 120。

    120fps 的一帧预算只有 8.3ms，而单次 mss 抓屏约 7ms，再叠 CPU 合成，
    预算已经贴边；低配机/高分屏/动态桌面会一直落在“差一点来得及”的区间。
    默认 60fps 把预算抬到 16.6ms，显示线程也不再用 4ms 定时器空转。
    """
    try:
        fps = int(os.environ.get("DSH_GLASS_MAX_FPS", "60"))
    except (TypeError, ValueError):
        fps = 60
    return max(30, min(120, fps))


MAX_FPS = _max_fps()
# 主线程按目标帧率唤醒；旧值固定 4ms（250Hz），后台却按 120fps 合成，
# 抓屏 + 合成一旦超过 8.3ms，主线程还在空转堆积 after 回调。
INTERVAL_MS = max(4, int(1000 / MAX_FPS))
# 静止画面下「有没有变」只能靠抓屏看，单次 grab ~7ms；空转按 60fps 就是 40% 单核。
# 降到 30fps 探针，有变化时 idle 立刻归零、下一拍恢复全速。
PROBE_FPS = 30

# 仅用于文档截图/CI 视觉检查：暂停抓屏并把 WDA 关掉，窗口才会出现在截图里
PREVIEW = os.environ.get("DSH_GLASS_PREVIEW") == "1"
# 文档截图：正常抓屏 2.5 秒后暂停并取消 WDA，保留最后一帧玻璃
SNAPSHOT = os.environ.get("DSH_GLASS_SNAPSHOT") == "1"
# GPU：native 表示全分辨率采样（边缘透镜没有 1/4 放大的像素感）
NATIVE = os.environ.get("DSH_GLASS_NATIVE") == "1"
USE_GPU = NATIVE or os.environ.get("DSH_GLASS_GPU") == "1"
# 气泡底板（和 glass_geometry.BUBBLE_PLATE 同一个开关）：关掉 = 回到逐字翻色，
# 只用来拍新旧对比图，正常别动。
PLATE = os.environ.get("DSH_GLASS_PLATE", "1") != "0"

# 样式预设。`auto` 只出现在配置里（表示"看环境自动选"），解析后只会是下面三个之一。
STYLE_LIVE, STYLE_FROST, STYLE_SOLID = "live", "frost", "solid"
GLASS_STYLES = (STYLE_LIVE, STYLE_FROST, STYLE_SOLID)
# 静态样式：不抓屏、不起渲染线程，只在换尺寸/换形状时重画一张底板。
STATIC_STYLES = (STYLE_FROST, STYLE_SOLID)

HERE = Path(__file__).resolve().parent


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


# ---------------------------------------------------------------- 路径与配置

def cache_dir() -> Path:
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return Path(d)
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return Path(local) / "dsh-video-storyboard" / "cache"
    return Path(os.environ.get("XDG_CACHE_HOME") or "~/.cache").expanduser() / "dsh-video-storyboard"


CHAT_FILE = cache_dir() / "chat.jsonl"
# mic.py 正在说的这半句（实时转写）：窗口拿去弹那条"输入框"，边说你边看见字
MIC_PARTIAL = CHAT_FILE.parent / "mic-partial.json"
CONFIG = Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "watch-window.json"
MIC_SCRIPT = HERE / "mic.py"

# **心跳**：插件侧靠它区分「进程还在」和「窗口真的在画」。只看 pid 不够 ——
# pid 会被复用，进程也可能活着但界面已经卡死，那样宿主会永远认为窗还开着，
# 于是再也不重开（see-now issue #2 第 3 条）。每秒最多写一次。
HEARTBEAT = cache_dir() / "window-heartbeat"
HEARTBEAT_EVERY = 1.0


def read_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


STATUS_DEFAULTS = {
    "watching": False,   # 循环在不在跑
    "focused": False,    # DSH 是不是前台
    "pausedByFocus": False,  # 是不是"因为 DSH 抢了焦点才停的"
    "resume": True,      # 焦点回来要不要自动接着看
    "muted": False,      # 静音：只有字，没有声（= volume 0，留着给旧配置兼容）
    "volume": 100,       # 音量 0~100。0 就是静音；宿主念之前读它
}


VOL_TRACK_H = 104   # 音量条轨道的像素高度（越长越好调，但别盖住第一条气泡）


def status_of(cfg: dict | None = None) -> dict:
    """宿主写进 `watch-window.json` 的 `status` 段（缺项按默认补齐）。

    为什么要宿主管这段：陪看停没停、焦点在谁那儿、要不要自动续看 —— 这三件事只有
    Node 那边知道；窗口这边只管画。反过来"音量/静音"是用户在这里拖的，窗口写、宿主读。
    一个文件两头读写，谁都不用新增一条协议。

    **`cfg=None` 时必须现读盘**：以前这里只处理"传进来的 dict"，于是
    `status_of()`（静音按钮就是这么调的）永远返回默认值 —— 音量被当成 100、
    `watching` 被当成 False，点一下静音会把整段 status 覆盖成默认再写回去，
    顶栏那格立刻变「已暂停」。用户看到的"点了静音，正在陪看没了"就是这条。
    """
    if cfg is None:
        cfg = read_config()
    raw = {}
    if isinstance(cfg, dict):
        raw = cfg.get("status") if isinstance(cfg.get("status"), dict) else {}
    out = dict(STATUS_DEFAULTS)
    for key, default in STATUS_DEFAULTS.items():
        if key not in raw:
            continue
        if key == "volume":
            # 音量是数字，别跟着 bool() 走 —— bool(0.7) 是 True，bool(0) 是 False，
            # 一过这道手就全变成"0 或 100"了。
            try:
                out[key] = max(0, min(100, int(round(float(raw[key])))))
            except Exception:
                out[key] = default
        else:
            out[key] = bool(raw[key])
    # muted 和 volume 互相兜底：老配置只有 muted，新配置只有 volume
    if "muted" in raw and "volume" not in raw:
        out["volume"] = 0 if raw["muted"] else out["volume"]
    if out["volume"] <= 0:
        out["muted"] = True
    return out


def write_config(patch: dict, drop=()) -> None:
    """合并写。`drop` 里的键会被删掉（`mode: full` 不落盘，见 `_write_mode`）。"""
    cfg = read_config()
    cfg.update(patch or {})
    for key in drop:
        cfg.pop(key, None)
    try:
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG)
    except Exception:
        pass


def capturable() -> bool:
    """录屏 / 截图能不能拍到窗口。

    默认**不能**：走 `WDA_EXCLUDEFROMCAPTURE`，窗口不会出现在截图、直播、共享屏幕里。
    要给别人看效果（录视频）就在 `~/.dsh/watch-window.json` 写 `{ "capturable": true }`。
    环境变量 `DSH_GLASS_WDA=0` 只对这一次启动有效（插件拉起窗口时不传环境变量）。
    """
    if os.environ.get("DSH_GLASS_WDA") == "0":
        return True
    try:
        return read_config().get("capturable") is True
    except Exception:
        return False


# 远程控制软件不一定置 SM_REMOTESESSION；它们的窗口/类名是最稳的旁证。
# 命中任意一个就按 remote 处理，用 solid 底板，保证对面能看到整窗。
REMOTE_MARKS = (
    "gameviewer", "todesk", "sunlogin", "anydesk", "teamviewer",
    "rustdesk", "parsec", "uu远程", "向日葵",
)


def remote_capture_likely() -> bool:
    """当前是不是远程/捕获环境：RDP 标志位 + 常见远程软件窗口。"""
    if not IS_WIN:
        return False
    try:
        if ctypes.windll.user32.GetSystemMetrics(0x1000):  # SM_REMOTESESSION
            return True
    except Exception:
        pass
    try:
        u = ctypes.windll.user32
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        u.GetWindowTextLengthW.restype = ctypes.c_int
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetWindowTextW.restype = ctypes.c_int
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetClassNameW.restype = ctypes.c_int
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsWindowVisible.restype = wintypes.BOOL
        hit = [False]

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _lparam):
            if not u.IsWindowVisible(hwnd):
                return True
            n = u.GetWindowTextLengthW(hwnd)
            title = ""
            if n > 0:
                buf = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, buf, n + 1)
                title = buf.value
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, cls, 256)
            hay = (title + " " + cls.value).lower()
            if any(mark in hay for mark in REMOTE_MARKS):
                hit[0] = True
                return False
            return True

        u.EnumWindows(visit, 0)
        return hit[0]
    except Exception:
        return False


def glass_style(cfg: dict | None = None) -> str:
    """样式预设：live（实时玻璃）/ frost（静态磨砂）/ solid（纯色）。

    `WDA_EXCLUDEFROMCAPTURE` 会让窗口在远程桌面、OBS、截图工具里**整窗消失**
    （微软文档：“Everywhere else, the window does not appear at all”）。
    本机看起来正常，因为 mss 抓到的是窗口背后的像素；远程端却连文字都看不到。
    所以选了 live 也要在远程环境下兜底成 solid —— 好看不能压过"看得见"。

    性能反过来是另一头：live 每帧都要抓屏 + 模糊，低配机/高分屏上会明显掉帧。
    frost 和 solid 都不碰屏幕，只在换尺寸时画一张（见 `glass_static.py`）。

    读 `~/.dsh/watch-window.json` 的 `glass`；不写 / `auto` = 按环境自动选。
    环境变量优先级更高，只对这一次启动有效（插件拉起窗口时不传环境变量）。
    """
    if os.environ.get("DSH_GLASS_SOLID") == "1":
        return STYLE_SOLID
    if os.environ.get("DSH_GLASS_FROST") == "1":
        return STYLE_FROST
    if os.environ.get("DSH_GLASS_LIVE") == "1":
        return STYLE_LIVE
    if cfg is None:
        try:
            cfg = read_config()
        except Exception:
            cfg = {}
    try:
        mode = str((cfg or {}).get("glass") or "").strip().lower()
    except Exception:
        mode = ""
    if mode == STYLE_FROST:
        return STYLE_FROST
    if mode == STYLE_SOLID:
        return STYLE_SOLID
    if mode == STYLE_LIVE:
        return STYLE_SOLID if remote_capture_likely() else STYLE_LIVE
    # 空值 / auto：RDP 标志位或常见远程软件窗口任一命中，就用 solid。
    return STYLE_SOLID if remote_capture_likely() else STYLE_LIVE


def no_activate_wanted(cfg: dict | None = None) -> bool:
    """`~/.dsh/watch-window.json` 的 `noActivate`：点窗不激活它（默认关）。

    **为什么要它**：悬浮窗是 topmost，鼠标点一下会把它激活，Windows 随之重排
    topmost 带 —— 用户开着全屏游戏时，宿主窗跟着被顶上来、游戏被切走（#44 第 1 条）。

    **为什么默认关**：`WS_EX_NOACTIVATE` 的窗口拿不到键盘焦点，输入框直接打不了字。
    打开之后点输入区会先摘掉这条样式（见 `_focus_input`），但那条路没法自动化验证，
    所以让用户自己选，而不是替他决定。

    环境变量 `DSH_WINDOW_NO_ACTIVATE=1` 优先级更高（只对这一次启动有效）。
    """
    if os.environ.get("DSH_WINDOW_NO_ACTIVATE") == "1":
        return True
    if cfg is None:
        try:
            cfg = read_config()
        except Exception:
            cfg = {}
    try:
        return bool((cfg or {}).get("noActivate"))
    except Exception:
        return False


# ---------------------------------------------------------------- 模式与弹幕
#
# 三档模式（互斥）+ 一个正交的弹幕开关：
#
#   full     完整玻璃窗（折叠成 78 高横条是 UI 内的临时态，不落盘）
#   mini     小悬浮窗：两条胶囊，还在屏幕上。上排「静音 / 回到大窗 / 关闭」，
#            下排「语音 / 文字」。原来「—」是缩到托盘，用户要求改成这一档。
#   hidden   真藏起来：withdraw + 托盘图标（宿主 `see_now({action:"window",show:false})`
#            仍然走这一档）
#
# 弹幕是独立窗口（`danmaku.py`），和模式正交：`hidden + 弹幕` 就是
# "打游戏不挡视野、又能瞥一眼消息"的那一档。

MODE_FULL, MODE_HIDDEN, MODE_MINI = "full", "hidden", "mini"
WINDOW_MODES = (MODE_FULL, MODE_HIDDEN, MODE_MINI)
DANMAKU_EDGES = ("top", "bottom")

# 最小化后的**第二**恢复通道：Windows 11 会把新托盘图标塞进溢出区（要点 ∧ 才看得见），
# 只靠图标用户可能根本找不到窗口。热键用 GetAsyncKeyState 轮询 —— 不能用
# RegisterHotKey：那要独占一个消息循环，和 Tk 的抢。
VK_CTRL, VK_ALT, VK_W = 0x11, 0x12, 0x57
HOTKEY_GAP = 1.2          # 秒，长按不重复触发


def window_mode(cfg=None) -> str:
    """配置要哪一档。

    `mode` 是新的唯一真相源；但**老的 `hidden` 布尔键必须继续生效** ——
    磁盘上的配置是两个人写的（插件和自己），只认新键会让"点了藏起来"的老用户
    升级后窗口又冒出来。

    三档：`full` 完整窗、`mini` 小悬浮窗（两条胶囊，还在屏幕上）、`hidden`
    真藏起来（托盘 / withdraw）。`mini` 是这一版新加的档位，老配置里不存在，
    所以读到它只能是新写的。
    """
    if cfg is None:
        cfg = read_config()
    cfg = cfg or {}
    mode = str(cfg.get("mode") or "").strip().lower()
    if mode in WINDOW_MODES:
        return mode
    return MODE_HIDDEN if cfg.get("hidden") is True else MODE_FULL


def danmaku_wanted(cfg=None) -> bool:
    """默认关：替用户决定"打游戏时飘字"是不礼貌的。"""
    if cfg is None:
        cfg = read_config()
    return (cfg or {}).get("danmaku") is True


def danmaku_options(cfg=None) -> dict:
    if cfg is None:
        cfg = read_config()
    cfg = cfg or {}
    try:
        speed = int(cfg.get("danmakuSpeed") or 220)
    except (TypeError, ValueError):
        speed = 220
    try:
        lanes = int(cfg.get("danmakuLanes") or 2)
    except (TypeError, ValueError):
        lanes = 2
    edge = str(cfg.get("danmakuEdge") or "top").strip().lower()
    return {"edge": edge if edge in DANMAKU_EDGES else "top",
            "lanes": max(1, min(3, lanes)),
            "speed": max(40, min(400, speed))}


# ---- 外观 / 气泡（用户在设置页里调的那一堆）----

UI_DEFAULTS = {
    "autoShrink": False,     # 静止一段时间自动缩成小悬浮窗
    "shrinkAfter": 20.0,     # 秒；3~3600
    "bubbleStay": 8.0,       # 秒；一条气泡在屏幕上待多久（1~120，0 = 不消失）
    "bubbleMax": 3,          # 同时最多几条（1~3，用户要求不超过 3）
    "textOpacity": 1.0,      # 文字不透明度（0.2~1）
    "bubbleOpacity": 1.0,    # 气泡底板不透明度（0~1）
    "bubbleColor": "#07111d",  # 气泡底板颜色（#rrggbb）
    "fontSize": 11,          # 正文字号（9~26）
    "fontColor": "#edf6ff",  # 正文颜色
    "fontBold": False,       # 正文加粗
    "fontFamily": "",        # 字体；空 = 跟系统默认
}

# 正文最多显示这么多字，再长就「……」（用户要求 150）
BUBBLE_CHARS = 150
# 一条气泡至少要让这么多字完整露出来（用户要求 80）—— 窗口再小也先保证它
BUBBLE_MIN_CHARS = 80
_HEX_RE = None


def _clamp_num(raw, default, lo, hi, cast=float):
    try:
        v = cast(raw)
    except (TypeError, ValueError):
        return default
    if v != v:                      # NaN
        return default
    return max(lo, min(hi, v))


def _hex_color(raw, default):
    """`#rrggbb` / `#rgb` → `#rrggbb`；别的（含中文颜色名）一律用默认值。"""
    s = str(raw or "").strip()
    if not s.startswith("#"):
        return default
    body = s[1:]
    if len(body) == 3:
        body = "".join(ch * 2 for ch in body)
    if len(body) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in body):
        return default
    return "#" + body.lower()


def ui_options(cfg: dict | None = None) -> dict:
    """设置页里那张「气泡与文字」卡：全部夹在合法区间，坏值退回默认。"""
    cfg = cfg or read_config()
    out = dict(UI_DEFAULTS)
    out["autoShrink"] = cfg.get("autoShrink") is True
    out["fontBold"] = cfg.get("fontBold") is True
    out["shrinkAfter"] = round(_clamp_num(cfg.get("shrinkAfter"), UI_DEFAULTS["shrinkAfter"], 3, 3600), 1)
    out["bubbleStay"] = round(_clamp_num(cfg.get("bubbleStay"), UI_DEFAULTS["bubbleStay"], 0, 120), 1)
    out["bubbleMax"] = int(_clamp_num(cfg.get("bubbleMax"), UI_DEFAULTS["bubbleMax"], 1, 3, int))
    out["textOpacity"] = round(_clamp_num(cfg.get("textOpacity"), 1.0, 0.2, 1.0), 2)
    out["bubbleOpacity"] = round(_clamp_num(cfg.get("bubbleOpacity"), 1.0, 0.0, 1.0), 2)
    _bbc = str(cfg.get("bigBubbleColor") or "").strip()
    if len(_bbc) == 7 and _bbc.startswith("#"):
        out["bigBubbleColor"] = _bbc.lower()
    _bc = str(cfg.get("bubbleColor") or "").strip()
    if len(_bc) == 7 and _bc.startswith("#"):
        out["bubbleColor"] = _bc.lower()
    out["fontSize"] = int(_clamp_num(cfg.get("fontSize"), UI_DEFAULTS["fontSize"], 9, 26, int))
    out["fontColor"] = _hex_color(cfg.get("fontColor"), UI_DEFAULTS["fontColor"])
    fam = str(cfg.get("fontFamily") or "").strip()[:40]
    out["fontFamily"] = fam
    return out


def _hex_rgb(color: str) -> tuple:
    body = _hex_color(color, UI_DEFAULTS["fontColor"])[1:]
    return tuple(int(body[i:i + 2], 16) for i in (0, 2, 4))


def mix_color(fg: str, bg: str, alpha: float) -> str:
    """把 `fg` 按 alpha 混到 `bg` 上，返回 `#rrggbb`。

    Tk 的 Canvas 文字**没有真 alpha**：`fill` 只能是实色。所以"文字透明度"
    只能这么假造 —— 把字色往它底下的颜色上掺。底板是深色的，掺得越多越暗，
    看起来就是"字变淡了"。底板同理：整窗 `-alpha` 管背景，气泡底板另算。
    """
    a = max(0.0, min(1.0, float(alpha)))
    fr, fg_, fb = _hex_rgb(fg)
    br, bg_, bb = _hex_rgb(bg)
    r = int(round(fr * a + br * (1 - a)))
    g = int(round(fg_ * a + bg_ * (1 - a)))
    b = int(round(fb * a + bb * (1 - a)))
    return f"#{r:02x}{g:02x}{b:02x}"


def append_user(text: str) -> None:
    CHAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def asr_python() -> str:
    """麦克风用哪个 Python。

    **优先用跑窗口的这个解释器**（`sys.executable`）。两个理由，都是踩出来的：

    1. 它是 `pythonw.exe` —— 用 PATH 上的 `python.exe` 起 `mic.py` 会**弹一个黑框**
       （用户报的"启动 asr 老是弹命令行窗口"）；
    2. `pyaudiowpatch` 只装在用户那个 asr venv 里。回退到 PATH 上的 python，
       `import pyaudiowpatch` 当场失败，而 stderr 是 DEVNULL，于是表现成
       "点了麦克风，什么都没发生"。

    显式配了 `DSH_ASR_PYTHON` / `DSH_FLOAT_PYTHON` 的仍然优先（给特殊环境留口子）。
    """
    for key in ("DSH_ASR_PYTHON", "DSH_FLOAT_PYTHON"):
        v = os.environ.get(key)
        if v:
            return v
    exe = sys.executable or ""
    # 万一窗口就是用 python.exe 起的：换成同目录的 pythonw.exe，别开控制台
    if os.name == "nt" and exe.lower().endswith("python.exe"):
        guess = exe[:-len("python.exe")] + "pythonw.exe"
        if os.path.exists(guess):
            exe = guess
    if exe and os.path.exists(exe):
        return exe
    return "python.exe" if os.name == "nt" else "python3"


def display_hz() -> int:
    try:
        u = ctypes.windll.user32
        g = ctypes.windll.gdi32
        dc = u.GetDC(0)
        hz = int(g.GetDeviceCaps(dc, 116))
        u.ReleaseDC(0, dc)
        return hz if hz > 0 else 60
    except Exception:
        return 60


# ---------------------------------------------------------------- 窗口

# 虚拟桌面 = 所有显示器拼起来的物理像素范围。主屏固定从 (0,0) 起算，
# 第二块屏可能在它左边 / 上面，那时坐标本来就是负的 —— 只拿
# winfo_screenwidth()（= 主屏宽度）当边界，窗口就永远离不开主屏（#8）。
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79


def work_area() -> tuple:
    """可用工作区（**不含任务栏**）：(x, y, w, h)。

    `virtual_bounds()` 给的是整块屏幕，底部任务栏也在里面 —— 按它夹位置，
    窗口就会压到任务栏上。用 `SystemParametersInfoW(SPI_GETWORKAREA)` 拿真正的
    工作区；拿不到就退回整块屏幕。
    """
    try:
        import ctypes
        import ctypes.wintypes as wt

        rect = wt.RECT()
        if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
            w = int(rect.right - rect.left)
            h = int(rect.bottom - rect.top)
            if w > 200 and h > 200:
                return int(rect.left), int(rect.top), w, h
    except Exception:
        pass
    return None


def virtual_bounds(fallback_w=0, fallback_h=0):
    """(x, y, w, h)：虚拟桌面左上角与尺寸，物理像素。

    取不到（非 Windows / 远程会话偶尔返回 0）就退回主屏 (0, 0, w, h)。
    """
    try:
        u = ctypes.windll.user32
        vx = int(u.GetSystemMetrics(SM_XVIRTUALSCREEN))
        vy = int(u.GetSystemMetrics(SM_YVIRTUALSCREEN))
        vw = int(u.GetSystemMetrics(SM_CXVIRTUALSCREEN))
        vh = int(u.GetSystemMetrics(SM_CYVIRTUALSCREEN))
        if vw > 0 and vh > 0:
            return vx, vy, vw, vh
    except Exception:
        pass
    return 0, 0, int(fallback_w or 0), int(fallback_h or 0)


class LiveGlass:
    def __init__(self):
        cfg = read_config()
        # **崩溃取证**：`pythonw` 没有 stderr，段错误时用户只看到"窗口没了"。
        # faulthandler 会在信号里把**所有线程**的 Python 栈写进这个文件 ——
        # 没有它，ctypes 回调踩内存这种问题只能靠猜（本机实测过两次 Segfault）。
        self._fault_log = None
        if os.environ.get("DSH_WINDOW_FAULTLOG", "1") != "0":
            try:
                import faulthandler
                log_path = cache_dir() / "window-fault.log"
                log_path.parent.mkdir(parents=True, exist_ok=True)
                self._fault_log = open(log_path, "a", encoding="utf-8", buffering=1)
                self._fault_log.write(
                    "\n=== start pid=%d %s ===\n" % (os.getpid(), time.strftime("%Y-%m-%d %H:%M:%S")))
                faulthandler.enable(file=self._fault_log, all_threads=True)
            except Exception:
                self._fault_log = None
        raw_name = cfg.get("name")
        self.name = (raw_name.strip()[:24] if isinstance(raw_name, str) and raw_name.strip()
                     else "陪看")

        self.feed = ChatFeed(CHAT_FILE)
        self._mic_proc = None
        # 实时转写预览（mic-partial.json）：说话时弹出的那条"输入框"
        self._live_box = None
        self._live_text = ""
        self._protocol = WindowProtocol() if WindowProtocol is not None else None
        # 告诉宿主"窗起来了"：它会据此把二 / 三号开关恢复成上次开窗时的状态
        # （关窗时三个开关全关、同时记下记忆，恢复只能发生在新进程起来之后）
        try:
            if self._protocol is not None:
                self._protocol.action("windowOpened")
        except Exception:
            pass
        self._collapsed = False
        self._saved_h = DEFAULT_H
        self._saved_w = DEFAULT_W
        self._mode = window_mode(cfg)
        # 小悬浮窗（mini）：替换原来的"缩到托盘"。「—」和自动缩小都进这一档
        self._mini = False
        # 文本输入条是不是展开着（默认收起，只留两个圆形按钮）
        self._text_open = False
        # 自动缩小：最近一次"有事发生"的时刻（新消息、打字、点按钮）
        self._auto_at = time.time()
        self._mouse_over = False
        # 音量拖拽节流用的时间戳
        self._vol_at = 0.0
        # 小悬浮窗贴边状态：(左右边, 上下边)，None = 没贴
        self._mini_edge = (None, None)
        self._mini_peeked = False        # 已经半藏出去了
        self._mini_last_mouse = time.time()
        # 输入按钮靠哪边：**画的时候定一次就缓存住**，否则拖动窗口后画面在左、
        # 命中判定却按实时位置算到右边去 —— 表现就是"有时候点得到有时候点不到"。
        self._side_cache = None
        # 标题栏第 3 个按钮：一个圆，点一下在"绿 / 红"之间切（功能等用户说）
        self._btn3 = bool((cfg or {}).get("focusLock"))
        # 悬停提示：None / "resume"（2 号）/ "btn3"（3 号）
        self._tip = None
        self._tip_win = None
        self._tip_label = None
        self._tip_job = None
        self._bubbles_on = (cfg or {}).get("bubbles") is not False
        try:
            self._glass_style = glass_style(cfg)
        except Exception:
            self._glass_style = "auto"
        self._hit_btn3 = None
        self._quick_cy = None
        self._quick_text_at = 0.0
        self._sbar = None
        self._sbar_drag = False
        self._sbar_at = 0.0
        # 输入按钮的交互状态：文字按钮的鼠标悬停、麦克风的按住
        self._hover_text = False
        self._mic_hold = False
        self._mic_down_at = 0.0
        self._mic_was_on = False
        # 抗锯齿圆按钮的图片缓存
        self._button_cache = {}
        self._glass_btn_cache = {}
        self._bare_icons = {}
        # 小窗的气泡（**只有小窗有**）：下新上老、到点消失，画在一扇独立的小窗里
        self._mini_bubbles: list = []
        self._bubble_win = None
        self._bubble_canvas = None
        self._bubble_expand_key = None
        # 每条消息第一次出现的时间：(role,text,at) → time.time()。气泡按它过期
        self._seen_at: dict = {}
        # 新气泡入场动画：key → 还要走几步
        self._slide: dict = {}
        # mini 那一档的按钮命中区（每次 _draw_mini 重算）
        self._mini_btns: dict = {}
        self._tray = None
        self._tray_hinted = False
        self._hotkey_at = 0.0
        self._danmaku = None
        # 未读角标：只看"比上次展开时更新的"消息。首次启动没有这个键时按现在算，
        # 否则历史 80 条会全算未读。
        self._last_read_at = int(cfg.get("lastReadAt") or time.time() * 1000)
        self._snapshot_done = False
        self._title_entry = None
        self._title_item = None
        self._editing = False
        self._hidden = False
        self._cfg_key = None
        # 标题栏那行状态（陪看 / 焦点 / 自动续看）—— 宿主管，窗口每 250ms 跟着盘走
        self._status = status_of(cfg)
        # 上一条 meta 文本：只在"变了"的那一下闪 4 秒，之后让位给状态行。
        # 不这么办的话，任何一条诊断（"窗没开起来"）会把状态行永久盖住。
        self._last_meta = ""
        # 音量条：`_vol_pop` = 展开着，`_vol_drag` = 正按着拖，`_vol_hide_job` = 延迟收起
        self._vol_pop = False
        self._vol_drag = False
        self._vol_hide_job = None
        # 静音前的音量。**初值给 0**：用户说"记的音量小于 4 就在开声音时设成 10"，
        # 所以没有记忆（刚启动就点静音开关）时也该落到 10，而不是傻乎乎跳 70。
        self._last_vol = 0
        # 弹出式输入条（大小窗共用一条）：Toplevel + 里面的 Entry
        self._text_popup = None
        self._popup_entry = None

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.title(self.name)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=KEY)
        # `-transparentcolor` 是 Tk 的 **Windows 专有** 属性：aqua 的合法集合是
        # `-alpha / -fullscreen / -modified / -notify / -titlepath / -topmost / -transparent`，
        # X11 也没有它。无条件调用 → `TclError: bad attribute "-transparentcolor"`，
        # 死在 `__init__` 里，用户看到的是"窗口起不来"（#45 macOS、PR #38 Linux 都栽在这行）。
        # 非 Windows 上就留着 KEY 这个底色（窗口退化成一张深色卡片），别再让整个窗口起不来。
        if IS_WIN:
            self.root.attributes("-transparentcolor", KEY)
        self.fonts = Fonts(self.root)
        # 外观/气泡设置：字号、颜色、加粗、字体、三个透明度、气泡停留与条数
        self._ui = ui_options(cfg)
        # 宿主写进来的快捷键（悬停说明里显示用）：{mic: [...], input: [...]}
        hk = cfg.get("hotkeys") if isinstance(cfg.get("hotkeys"), dict) else {}
        self._hotkeys = {
            "mic": [str(k) for k in (hk.get("mic") or [])],
            "input": [str(k) for k in (hk.get("input") or [])],
        }
        self.fonts.configure(self._ui["fontFamily"], self._ui["fontBold"])
        # 气泡底板的深浅要在这之前定下来：`Geometry.for_size` 会把底板烤进 overlay
        set_plate_alpha(128 * float(self._ui["bubbleOpacity"]))
        set_plate_color(self._ui.get("bigBubbleColor")
                        or self._ui.get("bubbleColor") or "#07111d")

        self._sw, self._sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        # 主屏尺寸只用来算默认位置；能拖到哪、抓屏能抓到哪，看虚拟桌面（多显示器）
        self._vx, self._vy, self._vw, self._vh = virtual_bounds(self._sw, self._sh)
        w, h, x, y = self._initial_geometry(cfg.get("geometry"))
        self._saved_h = h
        self._x, self._y = x, y
        self._geo = Geometry.for_size(w, h, btns=self._btns_box(w, h))
        # 入场：从下方 22px 滑上来（不碰 -alpha，避免和抠色冲突）
        self._intro_target_y = y
        self._intro_y = y + 22
        try:
            _x2, _y2, _w2, _h2 = self._clamp_into_screen(x, self._intro_y, w, h)
            x, self._intro_y, w, h = _x2, _y2, _w2, _h2
            self._x, self._y = int(x), int(self._intro_y)
        except Exception:
            pass
        self.root.geometry(f"{w}x{h}+{x}+{self._intro_y}")

        self.canvas = tk.Canvas(self.root, width=w, height=h, bg=KEY,
                                highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.text = TextLayer(self.root, self.canvas, self.fonts)
        # 背景透明度：整窗 -alpha。和 -transparentcolor 能共存（实测这两个属性
        # 互不干扰），所以不用为了调透明度牺牲"洞"（点击穿透的抠色区）。
        self._apply_opacity(cfg)

        self._img = None
        self._last_frame = None
        self._collapsed_frame = None
        self._bg = None
        self._entry = None
        self._entry_item = None
        self._bar = None
        self._bar_len = 0
        self._bar_color = "#b8cbe0"
        self._aux_at = 0.0

        self._hwnd = None
        self._excluded = False
        # 录屏模式（capturable）下 mss 会抓到窗口自己，必须每帧挖掉，见 fill_own_rect。
        # 缓存起来：读配置是磁盘 IO，不能每帧做。
        # **非 Windows 一律按"能抓到自己"处理**：那边没有 WDA，不挖就是"透过自己看自己"。
        self._cappable = capturable() or not IS_WIN
        # 样式：live / frost / solid。静态样式不抓屏、不设 WDA、不起渲染线程。
        self._style = glass_style(cfg)
        self._static = self._style in STATIC_STYLES
        self._solid = self._style == STYLE_SOLID
        self._drag = None
        self._resize = None
        self._preview_at = 0.0
        # Entry 的真光标被关掉（insertwidth=0），画面上那条线是自己画的，
        # 所以闪烁也得自己来。_caret_job 存 after 的 id，重排时取消，避免叠定时器。
        self._caret_on = True
        self._caret_job = None
        # 长消息展开：被截断的气泡点一下独占整个消息区，再点收起。
        # 存的是消息身份 (role, text, at) 而不是槽位下标 —— 新消息进来会让
        # 同一条消息换槽，存下标会变成"展开的是另一条"。
        self._expanded = None
        self._fit_clipped = False
        # 气泡队列：只留最近 `bubbleMax` 条，`_ghost` 是刚被顶掉那条的退场动画
        self._bubble_q: list = []
        self._ghost = None

        self._q: queue.Queue = queue.Queue(maxsize=1)
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._wx, self._wy, self._ww, self._wh = 0, 0, 0, 0
        self._geo_lock = threading.Lock()
        # 抓屏源和渲染线程都是「换成 live 才有」的东西：静态样式下两条都不存在，
        # 所以不在这里建，交给 `_start_worker()`（换样式时会再调用一次）。
        self._source = None
        self._renderer = self._make_renderer(self._geo)
        self._worker = None
        self._worker_stop = None

        self._hz = display_hz()
        self._target_fps = min(MAX_FPS, self._hz)
        self._ema = 1.0 / max(1, self._target_fps)
        self._draw_ms = 0.0       # Tk 主线程实际绘制耗时，用来给 after 留余量
        self._last_motion = 0.0

        self.feed.reload()
        self._layout()
        # 小窗气泡是独立窗口、只在来消息时重画 —— 改颜色/字号后这里立刻刷新一次
        try:
            if getattr(self, '_mini', False) and getattr(self, '_mini_bubbles', None):
                self._mini_bubble_tick()
        except Exception:
            pass

        self.root.deiconify()
        self.root.update_idletasks()
        self.text.refresh()
        self._set_exclude(not capturable() and not self._static)
        # 点窗不激活（可选，见 `no_activate_wanted`）。必须等窗口真的映射出来再设扩展样式，
        # 否则 Tk 自己那次 `overrideredirect` 会把样式重写回去。
        self._no_activate = no_activate_wanted(cfg)
        self._no_activate_on = False
        if self._no_activate:
            self.root.after(0, lambda: self._apply_no_activate(True))
        self._start_worker()
        # 托盘：只在最小化时出现。这是"缩到底下"之后唯一能点回来的地方。
        # `DSH_TRAY=0` 关掉它（只剩 Ctrl+Alt+W 和宿主工具）—— 二分排查段错误用：
        # 托盘是这里唯一碰 ctypes 回调的东西，崩和不崩只差这一个开关。
        if os.environ.get("DSH_TRAY", "1") != "0":
            try:
                from tray import TrayIcon
                self._tray = TrayIcon(self.root, tip=f"{self.name} · 点击展开",
                                      icon_png=str(HERE / "mic-dsh.png"),
                                      cache_dir=cache_dir(),
                                      # **必须带 save=True**：只把窗口放回来而不改配置，
                                      # 250ms 后 `_sync_config` 读到还是 `mode: hidden`，
                                      # 立刻又把它收回去（实测：点了托盘窗口闪一下就没了）。
                                      on_activate=lambda: self._apply_mode(MODE_FULL, save=True))
            except Exception as exc:
                self._tray = None
                print("tray unavailable", repr(exc), flush=True)
        self.root.lift()
        self.root.after(80, self.root.lift)
        self.root.after(120, self.root.focus_set)
        self.root.after(60, self._tick)
        self.root.after(30, lambda: self._intro_step(0))
        self.root.after(250, self._poll_chat)
        self.root.after(1200, self._keep_on_top)
        self.root.after(2000, self._watch_host)
        # 启动即按配置挂弹幕：`mode=hidden` / `mini` 走的是 __init__ 里的直接赋值，
        # 不经过 `_apply_mode()`，所以不能指望那条路把它带起来。
        self._sync_danmaku(cfg)
        if self._mode == MODE_HIDDEN:
            self._minimize()
        elif self._mode == MODE_MINI:
            # 等窗口真的 map 出来再缩，否则 geometry 会被 Tk 的首次布局改回去
            self.root.after(60, self._enter_mini)
        if SNAPSHOT:
            self.root.after(2600, self._snapshot_mode)

    # ---- 渲染后端 ----

    def _make_renderer(self, geo: Geometry):
        """按样式给一个渲染器：静态样式完全不碰屏幕。"""
        if self._static:
            from glass_static import StaticRenderer
            return StaticRenderer(geo, self._style)
        if USE_GPU:
            try:
                from glass_gpu import GpuRenderer
                return GpuRenderer(geo, MotionTracker(), native=NATIVE)
            except Exception as exc:
                print("GPU 初始化失败，回落到 CPU:", repr(exc), flush=True)
        return CpuRenderer(geo)

    def _start_worker(self) -> None:
        """起抓屏/合成线程。静态样式没有东西要算，直接不起。"""
        if self._static or self._worker is not None or self._stop.is_set():
            return
        self._source = CaptureSource((self._sw, self._sh), cappable=self._cappable,
                                     solid=self._solid,
                                     # 窗口落在副屏时，抓屏范围要按虚拟桌面钳
                                     bounds=(self._vx, self._vy, self._vw, self._vh))
        self._worker_stop = threading.Event()
        self._worker = threading.Thread(target=self._work, args=(self._worker_stop,),
                                        daemon=True)
        self._worker.start()

    def _stop_worker(self) -> None:
        """停线程。先摘掉引用再 join：`_work` 里还会读 `self._source`。"""
        worker, stop = self._worker, self._worker_stop
        self._worker, self._worker_stop = None, None
        if stop is not None:
            stop.set()
        if worker is not None:
            worker.join(timeout=0.4)

    # 输入圆按钮的底色**跟着窗口风格走**（用户要求：文字/语音同步变）
    BTN_STYLE_FILL = {
        # (圆按钮底, 圆按钮描边, 输入条底, 输入条文字)
        "solid": ((24, 34, 50), (58, 84, 116), "#16212f", "#e8f2ff"),
        "frost": ((34, 46, 64), (96, 124, 158), "#22303f", "#eaf4ff"),
        "live":  ((10, 18, 28), (72, 128, 180), "#0b131d", "#dcecff"),
        "auto":  ((10, 18, 28), (72, 128, 180), "#0b131d", "#dcecff"),
    }

    def _style_colors(self) -> tuple:
        """当前风格对应的四色 (按钮底, 按钮环, 输入条底, 输入条字)。"""
        style = str(getattr(self, "_glass_style", "") or "auto")
        return self.BTN_STYLE_FILL.get(style, self.BTN_STYLE_FILL["auto"])

    def _apply_style(self, style: str) -> None:
        """换样式（配置文件一变就调用，不用重开窗口）。

        从 live 切走要真把抓屏线程停掉 —— 只换渲染器而不停线程，等于"静态样式"
        还在后台每帧抓屏，用户切过去还是卡，只是看不见画面在变。
        """
        self._glass_style = str(style or "auto")
        if style not in GLASS_STYLES:
            style = STYLE_LIVE
        if style == self._style:
            return
        self._style = style
        self._static = style in STATIC_STYLES
        self._solid = style == STYLE_SOLID
        self._pause.set()
        self._stop_worker()
        try:
            self._renderer.close()
        except Exception:
            pass
        self._renderer = self._make_renderer(self._geo)
        if self._static:
            # 不再抓屏：WDA 没有意义，开着反而会让窗口在截图里消失
            self._set_exclude(False)
            self._last_frame = None
            if self._collapsed:
                # 折叠态贴的是 `_collapsed_frame`（不是 `_last_frame`）—— 清掉就是一块空白。
                # 按折叠尺寸直接画一张：`slabs_for()` 在折叠高度下只返回标题栏那一块。
                try:
                    self._collapsed_frame = self._renderer.frame_for(self._geo)
                except Exception:
                    self._collapsed_frame = None
            else:
                self._collapsed_frame = None
        else:
            self._start_worker()
        self._pause.clear()
        self._layout(seed=True)

    # ---- 尺寸 ----

    # 颜色表变了：旧的按钮图要全部作废并重画，
    # 否则两个圆和输入条还挂着上一套颜色的缓存图（看起来像“没换”）
    try:
        self._button_cache.clear()
    except Exception:
        pass
    try:
        self._layout()
        if getattr(self, "_text_popup", None) is not None:
            self._relayout_text_popup()
    except Exception:
        pass
    def _initial_geometry(self, geo):
        sw, sh = self._sw, self._sh
        w, h = DEFAULT_W, DEFAULT_H
        # 默认位置仍是主屏居中偏右下（和以前一致）；恢复位置按虚拟桌面钳位，
        # 否则上次存在第二块屏上的坐标（负数）会被拉回主屏左上角。
        x, y = max(40, sw - w - 80), max(40, (sh - h) // 2 - 40)
        try:
            size, rest = geo.split("+", 1)
            pw, ph = (int(v) for v in size.split("x"))
            px, py = (int(v) for v in rest.split("+")[:2])
            w = max(MIN_W, min(sw - 40, pw))
            h = max(MIN_H, min(sh - 40, ph))
            x = max(self._vx, min(self._vx + self._vw - w, px))
            y = max(self._vy, min(self._vy + self._vh - h, py))
        except Exception:
            pass
        return w, h, x, y

    def _sync_screens(self):
        """刷新虚拟桌面范围：接/拔显示器、改分辨率后不用重开窗口。

        拖动/缩放开始前调一次就够（GetSystemMetrics 很便宜，但没必要每帧问）。
        """
        vx, vy, vw, vh = virtual_bounds(self._sw, self._sh)
        if vw > 0 and vh > 0:
            self._vx, self._vy, self._vw, self._vh = vx, vy, vw, vh
        # 工作区（不含任务栏）：夹位置、贴边都用它
        wa = work_area()
        if wa:
            self._wx, self._wy, self._ww, self._wh = wa
        else:
            self._wx, self._wy, self._ww, self._wh = self._vx, self._vy, self._vw, self._vh
            if getattr(self, "_source", None) is not None:
                self._source.bounds = (vx, vy, vw, vh)
        return self._vx, self._vy, self._vw, self._vh

    def _set_geometry(self, geo: Geometry) -> None:
        """换一套几何：渲染器跟着换，静态跳帧的签名作废。"""
        self._geo = geo
        self._renderer.set_geometry(geo)
        self.canvas.config(width=geo.width, height=geo.height)

    def _apply_shapes(self, shapes) -> None:
        """气泡宽度/高度变了：尺寸相关的遮罩/折射图直接复用，只重算框。"""
        with self._geo_lock:
            self._set_geometry(self._geo.with_shapes(shapes))

    # ---- 窗口外观 ----

    def _intro_step(self, n: int) -> None:
        try:
            if n >= 6:
                self._y = self._intro_target_y
            else:
                self._y = self._intro_target_y + int(22 * (1 - (n + 1) / 6.0))
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
        except Exception:
            pass
        if n < 6:
            self.root.after(26, lambda: self._intro_step(n + 1))

    def _keep_on_top(self) -> None:
        """DSH 等置顶窗口被激活后会把悬浮窗压下去；定时重新抬到最上层。"""
        try:
            if not self._hidden:
                self.root.attributes("-topmost", True)
                self.root.lift()
        except Exception:
            pass
        try:
            self.root.after(1800, self._keep_on_top)
        except Exception:
            pass

    # ---- 跟着宿主一起关 ----

    def _host_alive(self) -> bool:
        """DSH 宿主（启动本窗口的那个进程）还活着吗。查不到就当活着 —— 别误杀。"""
        pid = 0
        try:
            pid = int(os.environ.get("DSH_HOST_PID") or 0)
        except Exception:
            return True
        if pid <= 0:
            return True
        try:
            import ctypes
            kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False
            code = ctypes.c_ulong(0)
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            kernel32.CloseHandle(handle)
            return bool(ok) and code.value == STILL_ACTIVE
        except Exception:
            return True

    def _watch_host(self) -> None:
        """DSH 关了，这扇窗也别留着 —— 它是陪看的小窗，没有宿主就只是屏上的一块玻璃。"""
        if not self._host_alive():
            try:
                self._stop_mic()
                self.root.destroy()
            except Exception:
                pass
            return
        try:
            self.root.after(2000, self._watch_host)
        except Exception:
            pass

    # ---- 协议 ----

    def _render_event(self, event) -> None:
        if not isinstance(event, dict):
            return
        if event.get("type") in ("message", "meta"):
            self.feed.add(ChatFeed.parse(json.dumps(event, ensure_ascii=False)))
            self._refresh_feed()
        elif event.get("type") == "control":
            self._apply_control(event)

    def _apply_control(self, event) -> None:
        action = str(event.get("action") or "")
        value = event.get("value")
        try:
            if action == "rename" and str(value or "").strip():
                self.name = str(value).strip()[:24]
                self.root.title(self.name)
                write_config({"name": self.name})
                self._refresh_feed()
            elif action == "collapse" and not self._collapsed:
                self.toggle_collapse()
            elif action == "expand" and self._collapsed:
                self.toggle_collapse()
            elif action in WINDOW_MODES:
                self._apply_mode(action, save=True)
            elif action == "danmaku":
                write_config({"danmaku": bool(value)})
                self._sync_danmaku()
            elif action == "micToggle":
                # 宿主侧快捷键：点按切换录音，和点麦克风按钮同一条路
                self._toggle_mic()
            elif action == "inputToggle":
                # 宿主侧快捷键：唤起/收起输入条，和点「字」按钮同一条路
                self._toggle_text_input()
            elif action == "resetFeed":
                # 换了绑定会话：把已经画在屏上的旧消息/气泡清掉（文件那边宿主已清空）
                try:
                    self.feed.reload()
                except Exception:
                    try:
                        self.feed.messages = []
                    except Exception:
                        pass
                try:
                    for item in list(self.canvas.find_all()):
                        tags = self.canvas.gettags(item)
                        if any(t in ("msg", "bubble", "row", "chat") for t in tags):
                            self.canvas.delete(item)
                except Exception:
                    pass
                self._last_frame = None
                self._layout()
            elif action == "hide":
                self._apply_mode(MODE_HIDDEN, save=True)
            elif action == "show":
                self._apply_mode(MODE_FULL, save=True)
        except Exception:
            pass

    def _drain_protocol(self) -> list:
        if self._protocol is None:
            return []
        try:
            return self._protocol.read_events()
        except Exception:
            return []

    def _replay_protocol(self) -> None:
        if self._protocol is None:
            return
        try:
            for event in self._protocol.reset_events(60):
                self._render_event(event)
        except Exception:
            pass

    # ---- 聊天轮询 ----

    def _poll_chat(self) -> None:
        try:
            self._sync_config()
            # 气泡到点退场**必须跟着主轮询走**，不能只挂在 _sync_config 末尾 ——
            # 配置文件没变化时 _sync_config 会提前返回，气泡就永远不消失（实报）。
            try:
                self._mini_bubble_tick()
            except Exception:
                pass
            if (self._hidden or self._mini) and self._hotkey_down():
                now = time.time()
                if now - self._hotkey_at > HOTKEY_GAP:
                    self._hotkey_at = now
                    self._apply_mode(MODE_FULL, save=True)
            for event in self._drain_protocol():
                self._render_event(event)
            if self._mic_proc is not None and self._mic_proc.poll() is not None:
                self._mic_proc = None
                self.feed.status = ""
                self._hide_live_text()
                self._refresh_feed()
            elif self._mic_proc is not None:
                self._poll_live_text()
            if self.feed.poll():
                # meta 行（诊断、宿主报错）**不再往标题栏弹绿字**（用户明确要求）。
                # 它仍然记在 `feed.status` 里、也还在日志里，只是不打扰。
                meta = (self.feed.status or "").strip()
                if meta:
                    self._last_meta = meta
                recent = list(self.feed.recent)
                if recent:
                    # 新消息 = 有事发生：自动缩小重新计时，展开的旧气泡收起
                    self._auto_at = time.time()
                    self._collapse_expanded()
                self._sync_bubbles(recent)
                if self._mini:
                    # **只有小窗弹气泡**：大窗照样是列表，不动
                    self._mini_bubble_push(recent)
                if recent:
                    self._refresh_feed()
                self._push_danmaku()
                self._sync_tray_tip()
        except Exception as exc:
            print("chat poll error", exc, flush=True)
        if not self._stop.is_set():
            self.root.after(250, self._poll_chat)

    def _apply_opacity(self, cfg=None) -> None:
        """`watch-window.json` 的 `opacity`（0.25~1）→ 整窗 -alpha。

        为什么用 `-alpha` 而不是在合成里乘：窗口底图是 glass 渲染出来的位图，
        掺 alpha 再交给 Tk 会被"抠色"当成分界 —— 半透明的地方会变成洞。
        整窗 alpha 是系统层做的事，抠色区该是洞的仍然是洞。
        """
        raw = (cfg if isinstance(cfg, dict) else read_config()).get("opacity")
        try:
            val = float(raw)
        except (TypeError, ValueError):
            val = 1.0
        val = max(0.25, min(1.0, val))
        self._opacity = val
        try:
            self.root.attributes("-alpha", val)
        except Exception:
            pass

    def _sync_config(self) -> None:
        """配置文件变了：样式、模式、弹幕、透明度都跟着改（不用重开窗口）。

        设置页写的是同一个文件，读一次盘把几个键全处理掉 —— 用户点一下下拉，
        250ms 内窗口就换过来。顺序有讲究：先换样式（会重建渲染器），再切模式
        （会改尺寸并重排），最后挂弹幕（放最后，少一次无谓的窗口创建）。
        """
        try:
            st = CONFIG.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key == self._cfg_key:
            return
        self._cfg_key = key
        cfg = read_config()
        self._apply_style(glass_style(cfg))
        # **每次配置变动都作废按钮图并重排**：风格没变时 `_apply_style` 会提前返回，
        # 只靠它内部的清缓存，用户切样式时看不到任何变化（实报两次）。
        try:
            self._button_cache.clear()
            self._layout()
            if getattr(self, "_text_popup", None) is not None:
                self._relayout_text_popup()
        except Exception:
            pass
        # **只有模式真的变了才切档**。以前无条件 `_apply_mode(...)`：宿主要么每 400ms
        # 写一次状态、要么我们自己的 `_save_geometry()` 写一次盘，都会走到这里，
        # 于是 `_layout()` 反复执行 —— 标题栏那两样手画的东西（三角、顶部线）
        # 就一直在闪；折叠时更糟：`_exit_mini()` 会把窗口重新撑回整窗高度。
        want_mode = window_mode(cfg)
        if want_mode != getattr(self, "_mode", None):
            self._apply_mode(want_mode, cfg=cfg)
        if abs(float(cfg.get("opacity") or 1.0) - float(getattr(self, "_opacity", 1.0))) > 0.001:
            self._apply_opacity(cfg)
        # 外观/气泡：字体、颜色、三个透明度、停留时长、条数。变了就重排一次
        ui = ui_options(cfg)
        if ui != self._ui:
            self._apply_ui(ui)
        # 快捷键：悬停说明里显示用，跟着文件热更新（改了设置不用重开窗）
        hk = cfg.get("hotkeys") if isinstance(cfg.get("hotkeys"), dict) else {}
        self._hotkeys = {
            "mic": [str(k) for k in (hk.get("mic") or [])],
            "input": [str(k) for k in (hk.get("input") or [])],
        }
        # 录屏模式热切换：capturable 一变就解除/恢复系统截屏排除（不用重开窗）。
        # 排除状态也同步给抓屏源：解除后拍到自己那一块会自动填掉，画面不会花。
        want_cap = capturable() or not IS_WIN
        if want_cap != getattr(self, "_cappable", False):
            self._cappable = want_cap
            try:
                src = getattr(self, "_source", None)
                if src is not None:
                    src.cappable = want_cap
            except Exception:
                pass
            if not self._static and not self._solid:
                try:
                    self._set_exclude(not want_cap)
                except Exception:
                    pass
        # 状态行单独比：它变得比样式勤（每次开停、切窗口都写一次盘），
        # 但绝大多数时候只是几个布尔，重排一次标题栏就够了。
        st = status_of(cfg)
        if st != self._status:
            self._status = st
            self._layout()
        # 三号开关（焦点判定锁）：宿主开窗时会把它恢复成上次的状态，窗口要跟着变
        want_lock = bool(cfg.get("focusLock"))
        if want_lock != bool(getattr(self, "_btn3", False)):
            self._btn3 = want_lock
            self._layout()
        self._auto_shrink_tick()
        self._mini_edge_tick()
        self._mini_bubble_tick()

    def _apply_ui(self, ui: dict) -> None:
        """设置页那几项变了：字体/颜色/透明度/气泡规则。

        **底板透明度必须重建几何**：它是 `_overlay()` 烤进位图里的，
        只改常量不重建，屏幕上看不出任何变化。
        """
        prev, self._ui = self._ui, ui
        self.fonts.configure(ui["fontFamily"], ui["fontBold"])
        # 颜色变了也必须重建几何：底板颜色是烤进 overlay 的（用户实报大窗颜色不生效）
        color_changed = (str(ui.get("bigBubbleColor") or "")
                         != str(prev.get("bigBubbleColor") or ""))
        if color_changed:
            set_plate_color(ui.get("bigBubbleColor") or "#07111d")
        plate_changed = (abs(float(ui["bubbleOpacity"])
                             - float(prev.get("bubbleOpacity", 1.0))) >= 0.05) or color_changed > 0.001
        if plate_changed:
            set_plate_alpha(128 * float(ui["bubbleOpacity"]))
            with self._geo_lock:
                self._set_geometry(Geometry.for_size(self._geo.width, self._geo.height,
                                                  btns=self._btns_box(self._geo.width, self._geo.height),
                                                     version=self._geo.version + 1,
                                                     mini=self._mini))
        self._layout()

    def _auto_shrink_tick(self) -> None:
        """静止够久就自己缩成小悬浮窗。

        `_auto_at` 在**有事发生**时被推后：新消息、打字、点按钮、鼠标停在窗上。
        鼠标停着不动也算"正在看"，不该把它缩掉。
        """
        ui = self._ui
        if not ui["autoShrink"] or self._mini or self._collapsed or self._hidden:
            return
        if self._mouse_over or getattr(self, "_text_popup", None) is not None:
            self._auto_at = time.time()
            return
        if time.time() - self._auto_at < float(ui["shrinkAfter"]):
            return
        self._auto_at = time.time()
        self._apply_mode(MODE_MINI, save=True)

    # ---- 输入 ----

    def _send(self, _event=None):
        if self._entry is None:
            return "break"
        text = self._entry.get().strip()
        if not text:
            return "break"
        try:
            append_user(text)
        except Exception as exc:
            self.feed.status = f"写不进去：{exc}"
            self._refresh_feed()
            return "break"
        try:
            self._entry.delete(0, "end")
        except Exception:
            pass
        try:
            if self._protocol is not None:
                self._protocol.action("say", text=text)
        except Exception:
            pass
        self._render_input()
        self.root.after(40, self._poll_chat)
        return "break"

    def _sbar_hit(self, x: int, y: int) -> bool:
        """点在滚动条上（左右各放宽 8px）。"""
        g = self._scrollbar_geom()
        if not g:
            return False
        try:
            body = self._geo.slabs[1]   # 主体（最后一块现在是按钮窄玻璃）
        except Exception:
            return False
        return abs(x - g[0]) <= 7 and body[1] <= y <= body[3]

    def _scroll_to_y(self, y: int, *, drag: bool = False) -> None:
        """按鼠标的 y 把消息流滚到对应位置（拖把手、点空白都走这里）。

        `drag=True` 是**拖动手柄**：必须立刻重排，不能走
        `_schedule_feed_refresh()` —— 那是"40ms 后再画"的防抖，鼠标一直在动
        就会一直取消重排，于是拖动期间文字不动、松手才跳（用户报的就是这个）。
        """
        g = self._scrollbar_geom()
        if not g:
            return
        try:
            body = self._geo.slabs[1]   # 主体（最后一块现在是按钮窄玻璃）
        except Exception:
            return
        _x, y0, y1 = g
        thumb = max(1, y1 - y0)
        top = body[1] + 8
        view_h = max(1, body[3] - body[1] - 16)
        t = (y - top - thumb / 2.0) / max(1, view_h - thumb)
        t = max(0.0, min(1.0, t))
        total = len(self.feed.messages)
        visible = self._slot_estimate()
        max_off = max(1, total - visible)
        self.feed.offset = int(round((1.0 - t) * max_off))
        if drag:
            now = time.time()
            if now - float(getattr(self, "_sbar_at", 0.0) or 0.0) >= 0.03:
                self._sbar_at = now
                job = getattr(self, "_feed_job", None)
                if job is not None:
                    try:
                        self.root.after_cancel(job)
                    except Exception:
                        pass
                    self._feed_job = None
                self._relayout_feed()
            return
        self._schedule_feed_refresh()

    def _wheel(self, e):
        if self._mini or self._collapsed:
            return
        if self.feed.scroll(1 if e.delta > 0 else -1):
            self._collapse_expanded()
            # 滚轮切进/切出历史模式：气泡队列要让位
            # 连滚只重排最后一次：滚十格就白画九遍（#44 第 2 条，社区实测每格卡 ~1 秒）
            self._schedule_feed_refresh()

    def _schedule_feed_refresh(self, delay: int = 40) -> None:
        job = getattr(self, "_feed_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
        self._feed_job = self.root.after(delay, self._run_feed_refresh)

    def _run_feed_refresh(self) -> None:
        self._feed_job = None
        self._relayout_feed()

    def _relayout_feed(self) -> None:
        """**只**重画聊天流那两层（滚轮走这条，不走整窗 `_layout()`）。

        `_layout()` 是 `delete("all")` + 标题栏 / 输入框 / 滚动条 / 事件绑定全部重来
        一遍；滚动时这些一个都没变，只有气泡和滚动条位置要跟着 `feed.offset` 走。
        把整窗重排放在滚轮上，就是社区报的"每滚一格卡将近一秒"（#44 第 2 条）。

        两个必须跟着做的：
        - `_draw_feed()` 可能因为折行数变了而换 `_geo`（气泡宽度跟着文字走），
          这时静态底板得重画一张，否则文字换了位置、底板还是上一套；
        - 删了 item 就必须 `text.reset()`：`_fixed` / `_colors` 存的是 item id，
          留着旧的会让新画出来的文字被当成"要跟背景翻色"，有底板的气泡会闪。
        """
        c = self.canvas
        shapes_before = self._geo.shapes
        # 删的是 `feedbody`，不是 `feed`：`_draw_input()` 里的「发送」两个字也挂着
        # `feed` tag（历史遗留），删 `feed` 会把按钮文字一起删掉，而 `_draw_feed()`
        # 不负责重画它 —— 滚一下滚轮发送键就变空白。
        c.delete("feedbody")
        c.delete("sbar")
        self.text.reset()
        self._draw_feed()
        self._draw_scrollbar()
        self.text.refresh()
        if self._geo.shapes != shapes_before:
            self._sync_static_frame()

    def _toggle_mic(self):
        if self._mic_proc is not None and self._mic_proc.poll() is None:
            self._stop_mic()
            return
        if not MIC_SCRIPT.exists():
            self.feed.status = "找不到 mic.py"
            self._refresh_feed()
            return
        try:
            # `CREATE_NO_WINDOW` 对商店版 python 的 app alias 不一定管用，
            # 再叠一层 STARTUPINFO + SW_HIDE：两样都上才真的不弹黑框。
            si = None
            flags = 0
            if os.name == "nt":
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = subprocess.SW_HIDE
                flags = 0x08000000          # CREATE_NO_WINDOW
            # `--engine auto`：装了 SenseVoice 就用它（中英混说、噪声、标点都更好），
            # 没装自动退回 paraformer。以前这里写死 `local`，换了模型也用不上。
            self._mic_proc = subprocess.Popen(
                [asr_python(), str(MIC_SCRIPT), "--engine", "auto"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=flags, startupinfo=si,
            )
            self.feed.status = "录音中"
        except Exception as exc:
            self.feed.status = f"麦起不来：{exc}"
        self._refresh_feed()

    def _stop_mic(self):
        p = self._mic_proc
        self._mic_proc = None
        self.feed.status = ""
        if p is not None and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        self._refresh_feed()

    CARET_MS = 530          # 和 Windows 默认的光标闪烁周期一致
    CARET_PAD = 3           # 光标右边至少留几个字符，别让它贴着可见段右缘

    def _visible_input(self, text: str, maxw: int, caret: int):
        """返回能放进 maxw 的那一段，以及光标在这一段里的字符下标。

        原来只从左边砍（`text = text[1:]`），等于永远把尾巴留在视野里：光标移到
        句首时会被推到看不见的地方。改成以光标为锚点开窗 —— 先保证光标可见，
        再尽量往两边补字。

        光标右边留 CARET_PAD 个字符：不留的话往左移动时光标会一直贴着右缘，
        看不出右边还有内容（20 字符文本 / 10 字符窗口实测，caret=10 和 caret=17
        的可见段右端都正好停在光标上）。
        """
        font = self.fonts.get(11)
        if font.measure(text) <= maxw:
            return text, caret
        lo = min(caret, len(text))
        hi = min(len(text), lo + self.CARET_PAD)
        # 右边余量优先：先确保 caret..caret+PAD 进得去，再往左补已经打出来的内容
        while hi > lo and font.measure(text[lo:hi]) > maxw:
            hi -= 1
        while lo > 0 and font.measure(text[lo - 1:hi]) <= maxw:
            lo -= 1
        while hi < len(text) and font.measure(text[lo:hi + 1]) <= maxw:
            hi += 1
        while lo > 0 and font.measure(text[lo - 1:hi]) <= maxw:
            lo -= 1
        return text[lo:hi], caret - lo

    def _render_input(self) -> None:
        """输入文字画在 Canvas 上；Entry 只负责 IME/键盘，永远不可见。"""
        if self._entry is None:
            return
        c = self.canvas
        c.delete("inputtext", "inputcursor")
        if not getattr(self, "_text_open", False):
            # 文本条收着：一个字都不画，连光标定时器一起停掉
            self._schedule_caret(False)
            return
        try:
            text = self._entry.get()
            focused = self.root.focus_get() is self._entry
            # 光标位置必须读 Entry 的真实插入点：原来按整段文字宽度算，等于把
            # 线永远钉在末尾，左右键移动时画面上的光标根本不动。
            caret = self._entry.index("insert")
        except Exception:
            text, focused, caret = "", False, 0
        x0, y0, x1, y1, _r = self._geo.input_shape
        x = self._input_points()[1][0] + self.TEXT_OFFSET
        y = y0 + 27
        maxw = max(60, x1 - x - 20)
        cx = None
        if not text and not focused:
            self.text.draw(x, y, "在这里跟它说话…", anchor="w", fill="#8e9db2",
                           size=11, tags=("inputtext", "inputzone"))
        elif text:
            font = self.fonts.get(11)
            shown, caret_in = self._visible_input(text, maxw, caret)
            self.text.draw(x, y, shown, anchor="w", fill="#eef6ff",
                           size=11, tags=("inputtext", "inputzone"))
            if focused:
                cx = x + font.measure(shown[:max(0, caret_in)])
        elif focused:
            cx = x
        if cx is not None and self._caret_on:
            c.create_line(cx + 1, y - 9, cx + 1, y + 9,
                          fill="#b9d7ff", width=1, tags=("inputcursor",))
        self._schedule_caret(cx is not None)
        self.text.refresh()

    def _schedule_caret(self, active: bool) -> None:
        """只有输入框拿着焦点时才跑闪烁定时器；失焦就停，不白烧 after。"""
        if self._caret_job is not None:
            try:
                self.root.after_cancel(self._caret_job)
            except Exception:
                pass
            self._caret_job = None
        if not active:
            self._caret_on = True
            return
        self._caret_job = self.root.after(self.CARET_MS, self._blink_caret)

    def _blink_caret(self) -> None:
        self._caret_job = None
        if self._entry is None:
            return
        try:
            if self.root.focus_get() is not self._entry:
                self._caret_on = True
                return
        except Exception:
            return
        self._caret_on = not self._caret_on
        self._render_input()

    def _on_input_key(self, _e=None):
        # 打字期间光标恒亮：这时闪烁反而碍事，和系统输入框一致
        self._caret_on = True
        self._render_input()
        return None

    def _toggle_text_input(self, _event=None):
        """「字」按钮：弹 / 收输入条（大窗小窗都走这一条路）。

        用户要求：「大小窗口都只有文字输入开关，不直接显示输入条，点击之后弹出输入条」——
        所以不再有"输入栏内联展开"那一套，统一弹一条独立的输入条。
        """
        return self._toggle_text_popup()

    def _focus_input(self, _e=None):
        """点输入栏空白处 = 想打字：弹输入条。"""
        return self._toggle_text_popup()

    # ---- 改名 ----

    def _edit_title(self, _event=None):
        if self._editing:
            return "break"
        self._editing = True
        if self._title_entry is None:
            self._title_entry = tk.Entry(self.root, font=self.fonts.spec(15), relief="flat",
                                         bd=0, bg="#1b2330", fg="#f7fbff",
                                         insertbackground="#f7fbff")
            self._title_entry.bind("<Return>", self._commit_title)
            self._title_entry.bind("<Escape>", self._cancel_title)
            self._title_entry.bind("<FocusOut>", self._commit_title)
        self._title_entry.delete(0, "end")
        self._title_entry.insert(0, self.name)
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
        self._title_item = self.canvas.create_window(68, 38, anchor="w",
                                                     window=self._title_entry, width=180)
        self._title_entry.focus_set()
        self._title_entry.select_range(0, "end")
        return "break"

    def _commit_title(self, _event=None):
        if not self._editing:
            return
        self._editing = False
        text = self._title_entry.get().strip()
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        if text and text != self.name:
            self.name = text[:24]
            self.root.title(self.name)
            write_config({"name": self.name})
            try:
                if self._protocol is not None:
                    self._protocol.action("rename", value=self.name)
            except Exception:
                pass
        self._refresh_feed()
        return "break"

    def _cancel_title(self):
        self._editing = False
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        self._refresh_feed()
        return "break"

    # ---- 折叠 ----

    def _set_collapsed(self, on: bool) -> None:
        """折叠 / 展开：只压高度，宽度不变。

        ⚠️ **这不是"最小化"**。用户说的最小化是"像网页那样缩到底下、完全不占屏幕"
        —— 那是 `_minimize()`（withdraw + 托盘）。760x78 的横条依然占着一整条，
        打游戏照样挡视野，所以别再把它当最小化用。
        这一版又多了 `mini`（两条胶囊的小悬浮窗），「—」走的是那一档。
        """
        if self._mini:
            return
        if on == self._collapsed:
            return
        # 先读真实坐标再切尺寸：_x/_y 只是启动时的缓存，拖动/缩放后已过期。
        self._sync_pos()
        if on:
            self._saved_h = self._geo.height
            self._collapsed = True
            # 先换成折叠尺寸的几何，再按它裁上一帧，否则圆角遮罩还是整窗高度
            self._set_geometry(Geometry.for_size(self._geo.width, collapsed_height()))
            self._collapsed_frame = self._geo.collapsed_frame(self._last_frame)
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout()
        else:
            self._collapsed = False
            self._collapsed_frame = None
            self._set_geometry(Geometry.for_size(self._geo.width, max(MIN_H, self._saved_h),
                                                  btns=self._btns_box(self._geo.width, max(MIN_H, self._saved_h))))
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout(seed=True)
        self._save_geometry()

    def toggle_collapse(self, _event=None):
        """▾ / 展开：完整 ↔ 折叠横条。不落盘，重启回到完整态。"""
        self._set_collapsed(not self._collapsed)
        self._report("collapse" if self._collapsed else "expand")
        return "break"

    def toggle_danmaku(self, _event=None):
        """标题栏那个「弹」：弹幕开关，不用绕到设置页。

        只靠颜色区分开/关，**不再弹绿字提醒**（用户：任何操作都不需要左上角弹绿字）。
        """
        want = not danmaku_wanted()
        write_config({"danmaku": want})
        self._sync_danmaku()
        self._layout()
        self._report("danmaku", value=want)
        return "break"

    def toggle_mute(self, _event=None):
        """点「♪」：静音 ↔ 上一次的音量。

        音量条是主入口（鼠标放上去就展开），这一下是"我想立刻闭嘴"的快捷方式。
        规则（用户指定）：
        - 静音时**先记住当前音量**；
        - 再点一次恢复那个数；
        - **记住的音量小于 4 就恢复成 10** —— 否则"静音→再点"等于没声音，
          看起来像按钮坏了。

        写的是 `status.volume` / `status.muted`：宿主读同一个文件决定这句要不要念、
        念多大声。窗口这边只落盘 + 重画，不碰播放器（播放器在宿主那边）。
        """
        st = dict(status_of())
        cur = int(st.get("volume") or 0)
        if cur > 0:
            self._last_vol = cur
            st["volume"] = 0
        else:
            back = int(getattr(self, "_last_vol", 0) or 0)
            if back < 4:
                back = 10
            st["volume"] = back
            # 恢复出来的就是新的"上次音量"，下次静音再记它
            self._last_vol = back
        st["muted"] = int(st.get("volume") or 0) <= 0
        self._status = st
        write_config({"status": st})
        self._layout()
        self._report("volume", value=int(st.get("volume") or 0))
        return "break"

    # ---- 模式 / 弹幕 ----

    def _report(self, action: str, **fields) -> None:
        """用户动作回给宿主（`window-outbox.jsonl`）。动作名必须在 JS 侧白名单里，
        否则 `appendWindowAction` 静默返回 null —— 表现是设置页状态永远不同步、
        而且没有任何报错。"""
        try:
            if self._protocol is not None:
                self._protocol.action(action, **fields)
        except Exception:
            pass

    def _write_mode(self, mode: str) -> None:
        """`mode` 与老的 `hidden` 一起写，两个键永远一致。

        只写 mode 的话，降级回老版本窗口（只认 hidden）会读到一个过期的 `false`，
        于是「藏起来的窗」又冒出来；反过来只写 hidden，新版本就不知道是 mini。
        **mini 不是藏起来**：`hidden` 必须写 false，否则宿主会以为用户看不见任何东西。
        """
        self._mode = mode
        patch = {"hidden": mode == MODE_HIDDEN}
        drop = ()
        if mode == MODE_FULL:
            # 默认态不落盘：和 `glass: auto` 一个道理，少一个键就少一次误判
            drop = ("mode",)
        else:
            patch["mode"] = mode
        write_config(patch, drop=drop)

    def _apply_mode(self, mode: str, *, save: bool = False, cfg=None) -> None:
        """切档。`save=False` 是配置驱动的（磁盘上已经是这个值，别回写）。

        **先落盘再切**：`_enter_mini`/`_exit_mini` 自己会写 geometry，那个文件一变
        `_sync_config` 就醒；要是此刻磁盘上还是旧档位，它会立刻把窗口拨回去
        （mini 刚缩下去就弹回大窗）。先写 `mode` 就没有这个缝。
        """
        try:
            self._hide_native_tip()
        except Exception:
            pass
        mode = mode if mode in WINDOW_MODES else MODE_FULL
        if save:
            self._write_mode(mode)
        if mode == MODE_HIDDEN:
            if self._mini:
                self._exit_mini()
            self._minimize()
        elif mode == MODE_MINI:
            self._restore()
            self._enter_mini()
        else:
            self._restore()
            self._exit_mini()
        self._sync_danmaku(cfg)

    # ---- 屏幕边界 ----

    def _clamp_into_screen(self, x: int, y: int, w: int, h: int) -> tuple:
        """把窗口矩形压进虚拟桌面（多显示器整体范围）。

        **大窗和小窗都不许出屏** —— 只有"贴边半藏"那一步是故意的例外
        （它自己算好位置，不走这里）。用户实测：从小窗放大回来时大窗有一截
        在屏幕外，拖动一下才回来 —— 根因就是放大只换了尺寸，没重新夹位置。
        """
        # **工作区**（不含任务栏）：窗口既不许出屏，也不许压任务栏
        if getattr(self, "_ww", 0) <= 0:
            try:
                self._sync_screens()          # 启动时可能还没算过，不然等于不夹
            except Exception:
                pass
        vx = getattr(self, "_wx", self._vx)
        vy = getattr(self, "_wy", self._vy)
        vw = getattr(self, "_ww", self._vw)
        vh = getattr(self, "_wh", self._vh)
        # 窗口比屏幕还大时先缩尺寸，否则"夹位置"会把它钉在左上角外沿
        if vw > 0:
            w = max(MIN_W if not self._mini else MINI_W, min(w, vw))
        if vh > 0:
            h = max(MINI_H, min(h, vh))
        x = max(vx, min(int(x), vx + max(0, vw - w)))
        y = max(vy, min(int(y), vy + max(0, vh - h)))
        return int(x), int(y), int(w), int(h)

    def _nearest_edge(self) -> str:
        """当前窗口离哪条屏幕边最近（left / right / top / bottom）。

        用户要求：点缩小时小窗**出现在最近的屏幕边缘**，不是原地缩小。
        """
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        try:
            x, y = self.root.winfo_x(), self.root.winfo_y()
        except Exception:
            x, y = self._x, self._y
        cx = x + self._geo.width / 2.0
        cy = y + self._geo.height / 2.0
        dist = {
            "left": abs(cx - vx),
            "right": abs((vx + vw) - cx),
            "top": abs(cy - vy),
            "bottom": abs((vy + vh) - cy),
        }
        return min(dist, key=dist.get)

    def _enter_mini(self) -> None:
        # 旧帧里烤着大窗的标题栏文字，留着就会被 `_layout(seed=True)` 拼到小窗上
        self._last_frame = None
        self._collapsed_frame = None
        """缩成小悬浮窗：两条胶囊，还在屏幕上，仍然是"能看见"的状态。

        替换了原来「缩到托盘」那一档：托盘图标对很多人来说等于"窗口不见了"，
        而用户要的是"小一点但还在"。真正的隐藏（withdraw）保留给宿主工具调用。

        **落点是"最近的屏幕边缘"**（像 360 桌面小球）：先算离哪条边最近，
        再贴着那条边吸住，然后才开始"3 秒没人碰就半藏"的倒计时。
        """
        if self._mini:
            return
        self._sync_pos()
        if not self._collapsed:
            self._saved_w, self._saved_h = self._geo.width, self._geo.height
        edge = self._nearest_edge()
        self._mini = True
        self._mini_bubbles = []
        self._bubble_expand_key = None
        self._text_open = False
        self._vol_pop = False
        self._collapsed = False
        self._collapsed_frame = None
        self._close_text_popup()
        with self._geo_lock:
            self._set_geometry(Geometry.for_size(MINI_W, MINI_H, mini=True, btns=self._mini_btns_box()))
        # 贴边：拿"当前窗口中心"去那条边上找位置，再夹回屏内
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        cx = self._x + (self._saved_w or MINI_W) / 2.0
        cy = self._y + (self._saved_h or MINI_H) / 2.0
        x, y = self._x, self._y
        if edge == "left":
            x = vx
        elif edge == "right":
            x = vx + vw - MINI_W
        elif edge == "top":
            y = vy
        else:
            y = vy + vh - MINI_H
        if edge in ("left", "right"):
            y = int(cy - MINI_H / 2)
        else:
            x = int(cx - MINI_W / 2)
        x, y, _w, _h = self._clamp_into_screen(x, y, MINI_W, MINI_H)
        self._x, self._y = x, y
        self.root.geometry(f"{MINI_W}x{MINI_H}+{x}+{y}")
        self._mini_edge = (edge if edge in ("left", "right") else None,
                           edge if edge in ("top", "bottom") else None)
        self._mini_peeked = False
        self._mini_last_mouse = time.time()
        self._auto_at = time.time()
        self._layout(seed=True)
        # 布局之后才确定"靠哪边"：把两个圆下面的玻璃垫按真位置重建一次
        # （初始几何用大窗尺寸算过，右侧时那块玻璃根本不存在）
        try:
            self._sync_button_band()
        except Exception:
            pass
        self._save_geometry(self._x, self._y)

    def _exit_mini(self) -> None:
        """从小悬浮窗回完整窗。尺寸用缩之前那一档，并**夹回屏幕内**。"""
        if not self._mini:
            return
        # 旧帧是小窗那一套，回大窗同样不能用（会看到两套标题栏）
        self._last_frame = None
        self._collapsed_frame = None
        # 半藏状态下 `winfo_x` 是屏幕外的坐标，不能拿它当基准存进 geometry
        self._x, self._y = self._mini_rest_pos(False)
        self._mini = False
        self._mini_edge = (None, None)
        self._mini_peeked = False
        self._mini_bubbles = []
        self._close_bubble_win()
        self._close_text_popup()
        w = max(MIN_W, int(self._saved_w or DEFAULT_W))
        h = max(MIN_H, int(self._saved_h or DEFAULT_H))
        # 小窗贴边 → 放大后必然有一截在屏外：这里夹回去（用户实测的那个 bug）
        self._x, self._y, w, h = self._clamp_into_screen(self._x, self._y, w, h)
        with self._geo_lock:
            self._set_geometry(Geometry.for_size(w, h, btns=self._btns_box(w, h)))
        self.root.geometry(f"{w}x{h}+{self._x}+{self._y}")
        self._auto_at = time.time()
        self._refresh_input_side()
        self._layout(seed=True)
        # 放大后即使"靠哪边"没变，垫片几何也是拿小窗时期的参数建的（y 是错的）：
        # 无条件对齐一次，垫片才贴得到按钮（用户实报：放大瞬间垫片消失）
        try:
            self._sync_button_band()
        except Exception:
            pass
        self._save_geometry(self._x, self._y)

    def _minimize(self) -> None:
        """最小化：真的从屏幕上消失，只在托盘留一个图标。

        `overrideredirect` 的窗口不进任务栏，`withdraw()` 之后屏幕上一点痕迹都没有
        —— 所以托盘图标是这条功能的**红线**：没有它，用户只能杀进程才找得回来。
        弹幕层是独立窗口，不受这里影响（`hidden + 弹幕` 才是"打游戏"的完整形态）。
        """
        if self._hidden:
            return
        self._hidden = True
        try:
            self.root.withdraw()
        except Exception:
            self._hidden = False
            return
        if self._tray is not None:
            self._tray.show()
            # 每次运行只提示一次：Windows 11 会把新图标塞进溢出区，不告诉用户
            # "东西在哪"，他只会觉得窗口被关掉了。
            if not self._tray_hinted:
                self._tray_hinted = True
                self._tray.notify("已最小化到托盘（Ctrl+Alt+W 也能叫回来）")

    def _restore(self) -> None:
        """从托盘回来。顺手把未读清零 —— 用户点开就是想看现在有什么。"""
        if not self._hidden:
            return
        self._hidden = False
        try:
            self.root.deiconify()
            self.root.attributes("-topmost", True)
            self.root.lift()
        except Exception:
            pass
        if self._tray is not None:
            self._tray.hide()
        self._mark_read()

    def _sync_danmaku(self, cfg=None) -> None:
        """弹幕开关。开 = 一条横跨屏幕的独立窗口；关 = 连定时器一起销毁。

        弹幕层和主窗的显隐是正交的：`hidden + 弹幕` 才是"打游戏最干净"那一档。
        """
        want = danmaku_wanted(cfg) if cfg is not None else danmaku_wanted()
        opts = danmaku_options(cfg) if cfg is not None else danmaku_options()
        if want:
            if self._danmaku is None:
                try:
                    from danmaku import DanmakuLayer
                    self._danmaku = DanmakuLayer(self.root, screen_w=self._sw,
                                                 screen_h=self._sh, **opts)
                except Exception as exc:
                    self._danmaku = None
                    print("danmaku init failed", repr(exc), flush=True)
            else:
                self._danmaku.set_options(**opts)
        elif self._danmaku is not None:
            self._danmaku.close()
            self._danmaku = None

    def _push_danmaku(self) -> None:
        """把本轮新增的消息推进弹幕队列。用户自己说的话不飘。"""
        if self._danmaku is None:
            return
        for msg in getattr(self.feed, "recent", ()):
            text = msg.get("text") or ""
            if text:
                self._danmaku.push(text, msg.get("role") or "assistant")

    def _unread(self) -> int:
        return sum(1 for m in self.feed.messages
                   if (m.get("at") or 0) > self._last_read_at)

    def _mark_read(self) -> None:
        now = int(time.time() * 1000)
        self._last_read_at = now
        write_config({"lastReadAt": now})

    def _hotkey_down(self) -> bool:
        """Ctrl+Alt+W 是否按下。只在最小化时问（其它时候窗口本来就在）。"""
        if not IS_WIN:
            return False
        try:
            u = ctypes.windll.user32
            return bool((u.GetAsyncKeyState(VK_CTRL) & 0x8000)
                        and (u.GetAsyncKeyState(VK_ALT) & 0x8000)
                        and (u.GetAsyncKeyState(VK_W) & 0x8000))
        except Exception:
            return False

    def _sync_tray_tip(self) -> None:
        """最小化时把"有几条新的"写进托盘提示。

        弹幕关掉之后，托盘那行字就是**唯一**的信号 —— 没有它，用户不知道要不要点开。
        """
        if self._tray is None or not self._hidden:
            return
        n = self._unread()
        self._tray.set_tip(f"{self.name} · {n} 条新消息" if n else f"{self.name} · 点击展开")

    # ---- 气泡布局 ----

    def _fit_lines(self, text, size, max_width, max_height) -> list[str]:
        """按框宽/框高折行并截断，避免文字溢出气泡。"""
        font = self.fonts.get(size)
        measure = font.measure
        ls = max(1, font.metrics("linespace"))
        max_lines = max(1, int(max_height // ls))
        no_start = "，。、；：！？）》」』…,.;:!?)]}"
        lines = []
        for para in str(text).splitlines() or [""]:
            cur = ""
            for ch in para:
                if not cur or measure(cur + ch) <= max_width:
                    cur += ch
                elif ch in no_start:
                    cur += ch          # 标点不能单独掉到下一行
                else:
                    lines.append(cur)
                    cur = ch
            lines.append(cur)
        # 调用方要知道这条到底被砍了没有：省略号自己看不出是"全文正好以…结尾"
        # 还是"被截断了"，而展开入口只该给真被砍的那几条。
        self._fit_clipped = len(lines) > max_lines
        if self._fit_clipped:
            lines = lines[:max_lines]
            last = lines[-1]
            while last and measure(last + "…") > max_width:
                last = last[:-1]
            lines[-1] = (last + "…") if last else "…"
        return lines or [""]

    @staticmethod
    def _msg_key(msg):
        """消息身份：(role, text, at)，和 ChatFeed.add 的去重键一致。"""
        return (msg.get("role"), msg.get("text"), msg.get("at"))

    def _expanded_index(self, shown):
        """当前展开的那条在 shown 里的下标；已经滚出视野就返回 None。"""
        if self._expanded is None:
            return None
        for i, msg in enumerate(shown):
            if self._msg_key(msg) == self._expanded:
                return i
        return None

    def _toggle_expand(self, key) -> None:
        """点截断的气泡：展开成独占整个消息区；再点收起。"""
        self._expanded = None if self._expanded == key else key
        self._layout()

    def _collapse_expanded(self) -> None:
        """新消息进来或翻页时自动收起：否则盯着一条老消息，新消息看不见。"""
        self._expanded = None

    # ---- 消息区：**大窗是列表，不是气泡** ----

    def _bubbles(self):
        """大窗显示的消息：就是聊天流最后 4 条，**不过期、不替换**。

        用户要求：「大浮窗页面不用搞气泡消失，按照原来那样列表展示就行。小浮窗才搞」——
        所以这里退回到原来的列表语义：滚轮能翻历史，4 条常驻，被空间截断的
        点一下展开。气泡队列（150 字、停留 N 秒、下新上老）只在小窗的气泡窗里。
        """
        return [{**m, "_alpha": 1.0, "_dy": 0.0} for m in self.feed.visible(self._slot_estimate())]

    def _sync_bubbles(self, new_msgs) -> bool:
        """大窗不再维护队列；保留这个名字是给调用方一个"没有变化"的答复。"""
        now = time.time()
        for m in new_msgs or ():
            self._seen_at[self._msg_key(m)] = now
        return False

    def _slot_estimate(self) -> int:
        """这一档高度最多能并排显示几条消息（滚动/翻页的步长用它）。"""
        try:
            return len(chat_layout(int(self._geo.height))[0])
        except Exception:
            return 4

    def _message_shapes(self, messages):
        """消息列表：**能放几条画几条**，每条按文字量定高。

        用户原话：「不是平均分给四条，而是显示更多信息」—— 所以条数不固定：
        从最新的一条往回数，装不下就停；每条的高度 = 时间戳 + 正文行数 × 行高。
        窗口拉高 → 条数变多（不是每条变胖）。
        """
        w, h = self._geo.width, self._geo.height
        base = shapes_for(w, h)
        left, right = base[0][0], base[0][2]
        input_top = h - 80
        band_top = MSG_TOP
        band_bottom = input_top - MSG_BOTTOM_MARGIN
        total_h = max(24, band_bottom - band_top)
        ui = self._ui
        size = int(ui["fontSize"])
        fbody = self.fonts.get(size)
        fstamp = self.fonts.get(max(9, size - 2))
        ls = max(1, fbody.metrics("linespace"))
        stamp_ls = fstamp.metrics("linespace")
        pad = 16
        gap = 8
        max_bubble = min(right - left, max(260, int((right - left) * 0.88)))
        min_bubble = min(120, max_bubble)
        content_max = max(90, max_bubble - 2 * pad)
        plate_bg = "#07111d"
        text_fill = mix_color(ui["fontColor"], plate_bg, float(ui["textOpacity"]))
        stamp_fill = mix_color("#a8b7c9", plate_bg, float(ui["textOpacity"]))

        entries = []          # (msg, lines, clipped, stamp, h)
        expanded_at = self._expanded_index(messages)
        if expanded_at is not None:
            m = messages[expanded_at]
            stamp = str(m.get("stamp") or "")
            sh = stamp_ls if stamp else 0
            lines = self._fit_lines(str(m.get("text") or ""), size, content_max,
                                    max(ls + 4, total_h - sh - 6))
            entries = [(m, lines, self._fit_clipped, stamp, total_h)]
        else:
            used = 0
            for m in reversed(messages):
                stamp = str(m.get("stamp") or "")
                sh = stamp_ls if stamp else 0
                room = total_h - used - sh - 6
                if room < ls + 4:
                    break
                lines = self._fit_lines(str(m.get("text") or ""), size, content_max, room)
                clipped = self._fit_clipped
                bh = sh + len(lines) * ls + 10
                if entries and used + bh > total_h:
                    break
                entries.append((m, lines, clipped, stamp, bh))
                used += bh + gap
            entries.reverse()

        shapes, infos = [], []
        y = band_top
        for (m, lines, clipped, stamp, bh) in entries:
            sh = stamp_ls if stamp else 0
            body_h = max(ls + 8, bh - sh)
            body_h = min(body_h, max(ls + 8, band_bottom - (y + sh)))
            is_user = str(m.get("role") or "").lower() in ("user", "me", "human")
            inner = max([0] + [fbody.measure(line) for line in lines])
            bw = min(max_bubble, max(min_bubble, inner + 2 * pad))
            by0 = y + sh
            by1 = by0 + body_h
            if is_user:
                bx1 = right
                bx0 = bx1 - bw
                tx, ta = bx1 - pad, "ne"
            else:
                bx0 = left
                bx1 = bx0 + bw
                tx, ta = bx0 + pad, "nw"
            shape = (int(bx0), int(by0), int(bx1), int(by1), min(26, max(16, int(body_h // 3))))
            shapes.append(shape)
            infos.append({
                "shape": shape, "is_user": is_user, "stamp": stamp,
                "tx": tx, "ta": ta, "lines": lines,
                "ty": by0 + max(4, (body_h - len(lines) * ls) // 2),
                "stamp_y": y, "stamp_x": tx, "ls": ls, "size": size,
                "fill": text_fill, "stamp_fill": stamp_fill,
                "clipped": clipped,
                "expanded": expanded_at is not None,
                "key": self._msg_key(m),
            })
            y += bh + gap

        # 末尾两个永远是「输入栏 / 发送」，`_draw_input` 按这个顺序取
        shapes.extend(base[-2:])
        return shapes, infos

    # ---- 布局 ----

    def _ensure_entry(self) -> None:
        """Entry 只建一次：每次消息都销毁重建会丢输入法状态和草稿光标。"""
        if self._entry is not None:
            return
        self._entry = tk.Entry(self.root, bg=KEY, fg=KEY, insertbackground=KEY,
                               relief="flat", bd=0, font=self.fonts.spec(11),
                               insertwidth=0, highlightthickness=0)
        self._entry.bind("<KeyRelease>", self._on_input_key)
        self._entry.bind("<Return>", self._send)
        self._entry.bind("<Escape>", lambda _e: self._toggle_text_input())
        self._entry.bind("<FocusIn>", lambda _e: self._render_input())
        self._entry.bind("<FocusOut>", lambda _e: self._render_input())
        # 插入点还能被鼠标和选择改动，这些不发 KeyRelease：不补这几个，点一下
        # 输入框中间，画面上的光标就跟不过去。after_idle 等 Entry 自己先处理完。
        for seq in ("<ButtonRelease-1>", "<B1-Motion>", "<<Selection>>"):
            self._entry.bind(seq, lambda _e: self.root.after_idle(self._on_input_key), add="+")

    def _layout(self, seed: bool = False, quick: bool = False) -> None:
        """整窗重排：标题栏 + 气泡 + 输入区 + 滚动条，然后把上一帧贴回去。

        `seed=True` 时按新尺寸缩放上一帧先顶着（缩放/展开的过渡帧）。
        `quick=True` 是**拖动缩放专用**：只画标题栏和两个圆按钮，不排消息 ——
        消息要逐字建 item（还带描边），一帧几十毫秒，拖起来就是闪和卡；
        松手 `_rebuild()` 再按新尺寸完整排一遍。
        """
        c = self.canvas
        geo = self._geo
        w, h = geo.width, geo.height
        # 每次整窗重排都重算"靠哪边"：开窗/切档/拖完都能立刻站对位置
        try:
            self._side_cache = self._side_now()
        except Exception:
            pass
        if quick:
            # 拖动缩放：**一个 item 都不删**，只换底板图（见 `_quick_frame`）
            self._quick_frame(w, h)
            return
        self._quick_cy = None
        self._sbar = None
        c.delete("all")
        self.text.reset()
        self._bg = c.create_image(0, 0, anchor="nw")

        frame = self._collapsed_frame if self._collapsed else self._last_frame
        if frame is not None and frame.size == (w, h):
            try:
                self._img = ImageTk.PhotoImage(frame, master=c)
                c.itemconfigure(self._bg, image=self._img)
            except Exception:
                pass
        elif seed and self._last_frame is not None:
            # 过渡帧也走九宫格：标题栏/输入栏不被压扁
            preview = self._nine_slice(self._last_frame, w, h)
            try:
                self._img = ImageTk.PhotoImage(preview, master=c)
                c.itemconfigure(self._bg, image=self._img)
            except Exception:
                pass
        if PREVIEW:
            c.create_rectangle(0, 0, w, h, fill="#0d131d", outline="", tags=("preview-bg",))
            c.tag_lower("preview-bg")

        if self._mini:
            # 小悬浮窗：两条胶囊，没有气泡区、没有输入栏、没有顶部装饰线
            self._draw_mini()
            self._bind_header()
            c.itemconfigure(self._bg, state="normal")
            self._bar = None
            self._sync_static_frame()
            self.text.refresh()
            return

        self._draw_header()
        if self._collapsed:
            self._bind_header()
            c.itemconfigure(self._bg, state="normal")
            # 迷你态不画顶部那条装饰线：240 宽时它横在名字上方，像一条穿头的
            # 进度条（截图确认过）。胶囊本身已经够小，不需要再给一个视觉锚点。
            self._bar = None
            self._sync_static_frame()
            self.text.refresh()
            return

        self._draw_feed()
        self._draw_input()
        # 文字按钮的悬停态（tag_bind 挂在 tag 上，重画不影响）
        c.tag_bind("in-text", "<Enter>", self._enter_text_btn)
        c.tag_bind("in-text", "<Leave>", self._leave_text_btn)
        self._draw_scrollbar()
        self._bind_header()
        c.tag_bind("send", "<Button-1>", self._send)
        c.tag_bind("inputzone", "<Button-1>", self._focus_input)
        c.tag_raise("close")
        c.tag_raise("send")

        self._bar_len = max(72, int(w * BAR_FRAC))
        self._bar = c.create_line(w // 2 - self._bar_len // 2, BAR_Y,
                                  w // 2 + self._bar_len // 2, BAR_Y,
                                  width=BAR_THICK, fill="#b8cbe0", capstyle="round",
                                  tags=("topbar",))
        self._bar_color = "#b8cbe0"
        # 气泡宽度变了 → 形状变了 → 静态底板要重画（缓存按 shapes 命中，没变就是 0 成本）
        self._sync_static_frame()
        self.text.refresh()
        # **首帧后校正一次按钮玻璃的位置**：建几何时窗口还没摆好，圆心 y 是估的，
        # 不校正就会一直偏下（用户实报"跟没改一样"）。
        if not getattr(self, "_band_checked", False):
            self._band_checked = True
            try:
                self._sync_button_band()
            except Exception:
                pass

    def _sync_static_frame(self) -> None:
        """静态样式：把当前尺寸/形状的底板贴上去（其余时间一帧都不算）。

        `_draw_feed()` 会在 `_layout()` 中途换掉 `self._geo`（气泡宽度跟着文字走），
        所以要在这里、在全部绘制之后再取一次帧 —— 否则贴上去的还是上一套气泡的
        底板，文字换了位置而底板没换。
        """
        if not self._static or self._collapsed or self._resize:
            return
        if self._bg is None:
            return
        try:
            frame = self._renderer.frame_for(self._geo)
        except Exception as exc:
            print("static plate error", exc, flush=True)
            return
        if frame is None or (frame is self._last_frame and self._img is not None):
            return
        self._last_frame = frame
        try:
            self._img = ImageTk.PhotoImage(frame, master=self.canvas)
            self.canvas.itemconfigure(self._bg, image=self._img)
            self.canvas.tag_lower(self._bg)
        except Exception as exc:
            print("static draw error", exc, flush=True)

    def _draw_header(self) -> None:
        """标题栏：`● 正在陪看 | 焦点·DSH | ♪ 弹 ⊖ ▾ ✕`

        **mini 下直接返回**：小窗有自己的 `_draw_mini()`，任何路径误调到这里都会
        在小窗面板里多画一行「正在陪看」（用户截图里那两行）。
        """
        if self._mini:
            return
        """标题栏：`● 正在陪看 | 焦点·DSH | ♪ 弹 ⊖ ▾ ✕`

        两格是**能点的**（用户手绘的那张图）：
        - 「正在陪看」点一下 → 开/停陪看（写 outbox，宿主那边真的停采集）；
        - 「焦点·DSH」点一下 → 开/关自动续看，**开=绿字、关=红字**。
          自动续看的开关只在这里，设置页那个勾已经删掉了。
        """
        c = self.canvas
        before = set(c.find_all())
        w = self._geo.width
        mic_on = self._mic_proc is not None and self._mic_proc.poll() is None
        dot = "#e05a5a" if mic_on else "#0a84ff"
        # 标题栏玻璃是 y=12..66，中心 39；右边 ♪/弹/⊖/▾/✕ 也在 38。点、文字、
        # 状态必须同一条水平中线，且字号要能完整落在条内，不能压到气泡区。
        # 左边那一簇整体往左挪 20px：窗口缩到最窄时，3 号圆会撞到右边的静音键。
        # 再往左就出玻璃板了（SLAB_OUT=12），所以这里以 34/48 为下限。
        cy, dot_x, title_x = 38, 34, 48
        c.create_oval(dot_x - 9, cy - 9, dot_x + 9, cy + 9,
                      outline="#2b4d73" if dot == "#0a84ff" else "#6b3030", width=1)
        c.create_oval(dot_x - 4, cy - 4, dot_x + 4, cy + 4, fill=dot, outline="")
        self._hit_watch = None
        self._hit_resume = None
        # 右边五个按钮占 214px（静音 + 弹 + ⊖ + ▾ + ✕）
        right_limit = w - 214          # noqa: F841 —— 留作以后截断用，当前没截
        # 标题栏只有这两格：**不再有任何"操作反馈绿字"**（用户明确要求）
        f_watch = self.fonts.get(13, True)
        f_focus = self.fonts.get(12, True)
        watch_on = bool(self._status.get("watching"))
        label = "正在陪看" if watch_on else "已暂停"
        self.text.draw(title_x, cy, label, anchor="w",
                       fill="#f7fbff" if watch_on else "#ffc48a",
                       size=13, bold=True, tags=("title", "watchhit"))
        # 宽度**按「正在陪看」固定**：切到「已暂停」时 2/3 号不许挪位置
        lw = f_watch.measure("正在陪看")
        self._hit_watch = (title_x - 4, cy - 13, title_x + lw + 4, cy + 13)
        x = title_x + lw + 8
        self.text.draw(x, cy, "|", anchor="w", fill="#4a5a70", size=12)
        x += 10
        focus = "DSH" if self._status.get("focused") else "别处"
        resume = bool(self._status.get("resume"))
        ftxt = f"焦点·{focus}"
        self.text.draw(x, cy, ftxt, anchor="w",
                       fill="#5fdc9a" if resume else "#ff8a8a",
                       size=12, bold=True, tags=("title", "resumehit"),
                       adapt=False)
        fw = f_focus.measure(ftxt)
        self._hit_resume = (x - 4, cy - 13, x + fw + 4, cy + 13)
        # ---- 第 3 个按钮（用户手绘）----
        # 判定区是一个圆：直径比「焦点XX」那行字的高度**略低**一点。
        # 绿 = 默认；红 = 圆变红，另外压一条圆角矩形在「焦点XX」上方（画在文字之后 = 盖住它）。
        try:
            line_h = int(f_focus.metrics("linespace"))
        except Exception:
            line_h = 16
        b3_d = max(10, line_h - 2)
        b3_r = b3_d / 2.0
        b3_cx = x + fw + 10 + b3_r
        b3_cy = cy
        self._hit_btn3 = (b3_cx, b3_cy, b3_r)
        if self._btn3:
            # 圆角矩形（用户最后一次的口径）：
            # - **宽度恢复原来那版**：从「焦点XX」左边一直铺到圆心；
            # - **高度 = 2 号按钮字高的 1/3**（linespace 27 → 9px）；
            # - 纵向**居中**在标题栏中线上（两端全圆角，半径 = 半个高度）；
            # - 颜色 / 不透明度和旁边那个红圆完全一致。
            bar_h = max(4.0, line_h / 3.0)
            bar_r = bar_h / 2.0
            self._round_rect(c, x - 2, b3_cy - bar_r, b3_cx + 1, b3_cy + bar_r,
                             bar_r, self.BTN3_RED, tags=("btn3", "hdr"))
        c.create_oval(b3_cx - b3_r, b3_cy - b3_r, b3_cx + b3_r, b3_cy + b3_r,
                      fill=self.BTN3_RED if self._btn3 else self.BTN3_GREEN,
                      outline="", tags=("btn3",))
        # ---- 右边五个按钮：**均匀分格**，从右边距往回排 ----
        # 以前是写死的 `w-206/w-168/w-134/w-94/w-54`：窗口一窄，静音键就顶到 3 号圆上。
        # 现在先算左簇的右端，再把剩下的宽度均分给五格；实在挤就压缩每格（下限 24），
        # 这样任何宽度都不会重叠、也不会越出玻璃板。
        vol = int(self._status.get("volume") or 0)
        margin = SLAB_OUT + 8
        left_end = b3_cx + b3_r
        slot = 38.0
        avail = (w - margin) - (left_end + 10)
        if avail < slot * 5:
            slot = max(24.0, avail / 5.0)
        start = w - margin - slot * 5

        def slot_x(i: int) -> float:
            return start + slot * (i + 0.5)

        mx = int(slot_x(0))
        self._mute_x = mx
        self.text.draw(mx, cy, "♪", anchor="center",
                       fill="#7fc4ff" if vol > 0 else "#55637a", size=16, tags=("mute",))
        # 判定区是**一个圆**，尺寸刚好放下图标（用户要求），圆心对音符
        try:
            mw = float(self.fonts.get(16, False).measure("♪"))
            mh = 16 * 1.1
        except Exception:
            mw = mh = 12.0
        self._hit_mute = (mx, cy, max(mw, mh) / 2.0 + 2)
        if vol <= 0:
            # 一个音符 + 一道斜杠：Tk 在 Windows 上画 emoji（🔕）不可靠，会变成方框，
            # 所以用"音符 + 斜杠"自己拼一个不会失手的图标。
            # 斜杠要压在**居中的**音符上：音符是按 `anchor="center"` 画在 mx，
            # 以前按左对齐算（mx+1 … mx+10），整条斜杠就偏到右边去了。
            c.create_line(mx - 6, cy - 8, mx + 6, cy + 6, fill="#e05a5a", width=1.6,
                          tags=("mute",))
        dm_on = danmaku_wanted()
        self.text.draw(slot_x(1), 38, "弹", anchor="center",
                       fill="#7fc4ff" if dm_on else "#55637a", size=13, tags=("danmaku",))
        self._hit_danmaku = (slot_x(1) - 12, 24, slot_x(1) + 12, 52)
        # 「↘」= 缩成小悬浮窗（和小窗里那个「↗」是同一套箭头字形，方向相反）
        bx = slot_x(2)
        self.text.draw(bx, cy, "↘", anchor="center", fill="#8fa0b8", size=18,
                       tags=("minimize",))
        self._hit_mini = (bx - 14, cy - 14, bx + 14, cy + 14)
        # 收起三角：**再放大**（用户要求），展开朝下、收起朝上
        tri = "▴" if self._collapsed else "▾"
        tri_size = 34
        tri_x = slot_x(3)
        # 三角字形在 em 框里偏下，画在 38 上看着比别的图标矮一截 —— 抬 4px 才同一条中线
        tri_y = 38 - 4
        self.text.draw(tri_x, tri_y, tri, anchor="center", fill="#8fa0b8", size=tri_size,
                       tags=("collapse",))
        # 判定区**贴着图案**：字形宽 + 高度只取视觉高度（行高的一半左右），
        # 不能用文字 item 的 bbox —— 那是整行字体的框，比三角大一大圈。
        try:
            tw = self.fonts.get(tri_size, False).measure(tri)
        except Exception:
            tw = 14
        th = max(10, int(tri_size * 0.52))
        self._hit_collapse = (tri_x - tw / 2 - 1, tri_y - th / 2,
                              tri_x + tw / 2 + 1, tri_y + th / 2)
        self.text.draw(slot_x(4), 38, "✕", anchor="center", fill="#9fb0c8", size=15,
                       tags=("close",))
        if self._vol_pop:
            self._draw_volume_popup(mx - 8)
        # 这一批统一打上 `hdr`：拖动时每 80ms 重画一次标题栏，不打标签就会叠出残影
        for item in c.find_all():
            if item not in before:
                c.addtag_withtag("hdr", item)

    def _mute_anchor(self) -> int:
        """静音键「♪」的横坐标（`_draw_header` 里按均匀分格算出来的）。"""
        return int(getattr(self, "_mute_x", self._geo.width - 206))

    def _draw_hover_tip(self, c, w: int) -> None:
        """2 / 3 号按钮的悬停说明条（用户指定）。

        - 2 号：绿 = 「焦点在 DSH 时暂停陪看」，红 = 「仅显示焦点状态」；
        - 3 号：不管绿红都显示「红色＝禁用焦点判定」。

        画在标题栏**下面**一点，带一个看得见的深色圆角底（第一版没有底，
        那片字浮在消息上像乱码；第二版塞进标题栏又被右边按钮挤得只剩半截）。
        """
        TEXTS = {
            "resume": ("焦点在 DSH 时暂停陪看" if self._status.get("resume")
                       else "仅显示焦点状态"),
            "btn3": "红色＝禁用焦点判定",
            "danmaku": "弹幕开关",
            "mini": "缩成小窗",
            "collapse": "收起历史消息" if not self._collapsed else "展开历史消息",
            "mute": "静音",
            "watch": "开始 / 停止陪看",
            "bubbles": "气泡开关",
        }
        txt = TEXTS.get(self._tip, "")
        if not txt:
            return
        if self._mini:
            # 小窗：画在面板下面那条透明区（面板里塞不下）
            f0 = self.fonts.get(11, False)
            tw0 = f0.measure(txt)
            bx = int(max(6, min((w - tw0) / 2, w - 6 - tw0)))
            self.text.draw(bx, self._geo.height - 14, txt, anchor="w",
                           fill="#9fb4cc", size=11, tags=("tip",))
            return
        anchor_x = (self._hit_resume or (68, 0, 68, 0))[0]
        if self._tip != "resume":
            hit = (getattr(self, "_hit_btn3", None) if self._tip == "btn3"
                   else (self._hit_danmaku if self._tip == "danmaku" else None))
            anchor_x = (hit[0] - 20) if hit else (w - 320)
        f = self.fonts.get(11, False)
        tw = f.measure(txt)
        bh, pad = 24, 10
        bw = tw + pad * 2
        bx = int(max(SLAB_OUT + 4, min(anchor_x, w - SLAB_OUT - 4 - bw)))
        by = 71
        # 底板：比玻璃亮一档 + 一圈描边，保证在任何背景上都看得清
        self._round_rect(c, bx, by, bx + bw, by + bh, 8, "#16212f", tags=("tipbox",))
        c.create_line(bx + 8, by, bx + bw - 8, by, fill="#31465e", width=1,
                      tags=("tipbox",))
        self.text.draw(bx + pad, by + bh / 2, txt, anchor="w", fill="#dbe8f5",
                       size=11, tags=("tip",))

    TIP_DELAY_MS = 380

    def _tip_text_of(self, key: str) -> str:
        """悬停说明文案 —— **跟着开关状态走**（用户要求）。"""
        if key == "danmaku":
            return f"弹幕：{'开' if danmaku_wanted() else '关'}"
        if key == "bubbles":
            return f"气泡：{'开' if getattr(self, '_bubbles_on', True) else '关'}"
        if key == "mute":
            return ""     # 音量不配说明（用户要求）
        if key == "resume":
            return ("焦点在 DSH 时暂停陪看" if self._status.get("resume")
                    else "仅显示焦点状态")
        if key == "btn3":
            return "红色＝禁用焦点判定"
        if key == "collapse":
            return "展开历史消息" if self._collapsed else "收起历史消息"
        if key == "mini":
            return "缩放"
        if key == "watch":
            return "停止陪看" if self._status.get("watching") else "开始陪看"
        if key == "mic":
            return f"短按切换录音，长按说话\n快捷键：{self._hotkey_line('mic')}"
        if key == "text":
            return f"唤起 / 收起输入框\n快捷键：{self._hotkey_line('input')}"
        return ""

    def _hotkey_line(self, key: str) -> str:
        """设置页里那条快捷键的显示文本；没设就是「未设置」。"""
        keys = (getattr(self, "_hotkeys", {}) or {}).get(key) or []
        return "+".join(str(k) for k in keys) if keys else "未设置"

    def _show_native_tip(self, text: str) -> None:
        """Windows 风格的小提示框：浅底、深字、细边、贴着鼠标，不抢焦点。"""
        if not text:
            self._hide_native_tip()
            return
        try:
            px, py = self.root.winfo_pointerxy()
        except Exception:
            px, py = 0, 0
        try:
            if self._tip_win is None or not self._tip_win.winfo_exists():
                top = tk.Toplevel(self.root)
                top.overrideredirect(True)
                top.attributes("-topmost", True)
                try:
                    top.attributes("-alpha", 0.97)
                except Exception:
                    pass
                frame = tk.Frame(top, bg="#8d8d8d")
                frame.pack(fill="both", expand=True)
                lbl = tk.Label(frame, text=text, bg="#f5f5f5", fg="#1b1b1b",
                               font=(self.fonts.family, 9), padx=8, pady=3,
                               justify="left")
                lbl.pack(padx=1, pady=1)
                self._tip_win, self._tip_label = top, lbl
            self._tip_label.config(text=text)
            self._tip_win.deiconify()
            self._tip_win.update_idletasks()
            w = self._tip_win.winfo_reqwidth()
            h = self._tip_win.winfo_reqheight()
            x = px + 14
            y = py + 20
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            x = max(vx + 4, min(x, vx + vw - w - 4))
            y = max(vy + 4, min(y, vy + vh - h - 4))
            self._tip_win.geometry(f"+{int(x)}+{int(y)}")
        except Exception:
            pass

    def _hide_native_tip(self) -> None:
        job = getattr(self, "_tip_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
            self._tip_job = None
        try:
            if getattr(self, "_tip_win", None) is not None and self._tip_win.winfo_exists():
                self._tip_win.withdraw()
        except Exception:
            pass

    def _update_hover_tip(self, x: float, y: float) -> None:
        """鼠标在哪一格上 → 有没有提示要切。变了才重画（避免每像素重画）。"""
        want = None
        if self._mini:
            for key in ("mute", "danmaku", "bubbles", "expand", "watch", "resume"):
                rect = (getattr(self, "_mini_btns", {}) or {}).get(key)
                if rect and rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]:
                    want = {"mute": "mute", "danmaku": "danmaku", "bubbles": "bubbles",
                            "expand": "mini", "watch": "watch", "resume": "resume"}[key]
                    break
            if want is None:
                hit3 = getattr(self, "_mini_btn3", None)
                hmic = getattr(self, "_mini_hit_mic", None)
                htxt = getattr(self, "_mini_hit_text", None)
                if hmic and (x - hmic[0]) ** 2 + (y - hmic[1]) ** 2 <= (hmic[2] + 4) ** 2:
                    want = "mic"
                elif htxt and (x - htxt[0]) ** 2 + (y - htxt[1]) ** 2 <= (htxt[2] + 4) ** 2:
                    want = "text"
                elif hit3 and (x - hit3[0]) ** 2 + (y - hit3[1]) ** 2 <= (hit3[2] + 2) ** 2:
                    want = "btn3"
        else:
            rect = getattr(self, "_hit_resume", None)
            if rect and rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]:
                want = "resume"
            elif self._btn3_hit(x, y):
                want = "btn3"
            else:
                mhit = getattr(self, "_hit_mute", None)
                mic = getattr(self, "_hit_mic", None)
                htxt = getattr(self, "_hit_text", None)
                if mic and (x - mic[0]) ** 2 + (y - mic[1]) ** 2 <= (mic[2] + 4) ** 2:
                    want = "mic"
                elif htxt and (x - htxt[0]) ** 2 + (y - htxt[1]) ** 2 <= (htxt[2] + 4) ** 2:
                    want = "text"
                elif mhit and (x - mhit[0]) ** 2 + (y - mhit[1]) ** 2 <= (mhit[2] + 1) ** 2:
                    want = "mute"
                else:
                    for key, want_key in (("_hit_danmaku", "danmaku"),
                                          ("_hit_mini", "mini"),
                                          ("_hit_collapse", "collapse")):
                        rect = getattr(self, key, None)
                        if rect and rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]:
                            want = want_key
                            break
        if want == getattr(self, "_tip", None):
            return
        self._tip = want
        job = getattr(self, "_tip_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
            self._tip_job = None
        if not want:
            self._hide_native_tip()
            return
        txt = self._tip_text_of(want)
        # 和 Windows 一样：停一会儿才弹
        try:
            self._tip_job = self.root.after(self.TIP_DELAY_MS,
                                            lambda t=txt: self._show_native_tip(t))
        except Exception:
            pass

    # ---- 标题栏两格的点击 ----

    def _toggle_watch_click(self) -> None:
        """点「正在陪看 / 已暂停」：开/停陪看。

        窗口自己停不了采集（采集在 Node 那边），所以只发一个动作出去，
        宿主读 `window-outbox.jsonl` 后真的 `stopWatching` / `startWatching`。
        按钮的状态 250~400ms 后由宿主写回 `status.watching`，这里不抢先改。
        """
        self._report("toggleWatch")
        self._auto_at = time.time()

    def _btn3_hit(self, x: float, y: float) -> bool:
        """第 3 个按钮的判定区是**圆**，不是方框（用户明确要求）。"""
        hit = getattr(self, "_hit_btn3", None)
        if not hit:
            return False
        cx, cy, r = hit
        return (x - cx) ** 2 + (y - cy) ** 2 <= (r + 1) ** 2

    def _toggle_btn3(self) -> None:
        """三号开关：绿 ↔ 红。

        红 = **锁住焦点判定**：窗口不再根据"焦点在不在 DSH"去暂停/继续，
        陪看状态只认一号总开关；绿 = 交回二号（焦点判定）决定。
        状态写进 `watch-window.json` 的 `focusLock`，宿主读它来决定要不要拦焦点事件。
        """
        self._btn3 = not self._btn3
        self._auto_at = time.time()
        try:
            write_config({"focusLock": bool(self._btn3)})
        except Exception:
            pass
        self._report("focusLock", value=bool(self._btn3))
        self._layout()

    def _toggle_resume_click(self) -> None:
        """点「焦点·DSH」：开/关自动续看（绿=开，红=关）。"""
        self._report("toggleResume")
        self._auto_at = time.time()

    def _volume_track(self, mx: int) -> tuple:
        """音量条的几何：面板左上角 + 轨道 x + 轨道上下端。拖拽和画图共用一份。"""
        x = mx + 4
        top, bottom = 84, 84 + VOL_TRACK_H
        return x, top, bottom

    def _volume_rect(self, mx: int) -> tuple:
        """整个面板的矩形（命中判定要用，和画出来的是同一份数字）。"""
        cx, top, bottom = self._volume_track(mx)
        pad = 10
        return cx - 13, top - pad, cx + 15, bottom + pad + 16

    def _vol_hit(self, x: int, y: int) -> bool:
        if not getattr(self, "_vol_pop", False):
            return False
        x0, y0, x1, y1 = self._volume_rect(self._mute_anchor())
        return x0 <= x <= x1 and y0 <= y <= y1

    def _draw_volume_popup(self, mx: int) -> None:
        """鼠标停在 ♪ 上时展开的竖音量条（普通音量条逻辑：点/拖到哪就是多少）。

        为什么画在标题栏**下面**而不是上面：窗口的上边缘就是屏幕上的那一刀，
        往上的东西会被裁掉；挂在下面最多遮住第一条气泡，松手就没了。
        面板整体带 `volpop` tag —— 鼠标移进来要取消关闭，移出去才收。
        """
        c = self.canvas
        cx, top, bottom = self._volume_track(mx)
        vol = int(self._status.get("volume") or 0)
        x0, y0, x1, y1 = self._volume_rect(mx)
        c.create_rectangle(x0, y0, x1, y1, fill="#141d2b", outline="#2b4058",
                           width=1, tags=("volpop",))
        # 轨道：底槽 + 已填部分（从下往上长，和系统音量条一致）
        c.create_rectangle(cx - 3, top, cx + 3, bottom, fill="#22304a", outline="",
                           tags=("volpop",))
        fill_top = bottom - (bottom - top) * vol / 100.0
        if vol > 0:
            c.create_rectangle(cx - 3, fill_top, cx + 3, bottom, fill="#4aa3ff", outline="",
                               tags=("volpop",))
        # 把手：一个圆。拖拽时跟手，不做平滑 —— 平滑会让人以为没跟上
        c.create_oval(cx - 7, fill_top - 7, cx + 7, fill_top + 7, fill=self._style_colors()[3],
                      outline="#2b4058", width=1, tags=("volpop",))
        self.text.draw(cx, y1 - 12, str(vol), anchor="center", fill="#dbe6f5", size=10,
                       tags=("volpop",))
        # **永远在最上层**：否则会被消息文字和气泡压住（用户实报）
        c.tag_raise("volpop")

    def _volume_at(self, y: int, mx: int) -> int:
        """把鼠标的 y 换算成 0~100（夹在轨道两端）。"""
        _cx, top, bottom = self._volume_track(mx)
        ratio = (bottom - y) / max(1, (bottom - top))
        return max(0, min(100, int(round(ratio * 100))))

    def _cancel_vol_hide(self) -> None:
        if self._vol_hide_job:
            try:
                self.root.after_cancel(self._vol_hide_job)
            except Exception:
                pass
            self._vol_hide_job = None

    def _show_volume(self, _event=None) -> None:
        self._cancel_vol_hide()
        if not self._vol_pop:
            self._vol_pop = True
            if self._mini:
                # **小窗没有 `_draw_header()`**（它在 mini 下直接 return），
                # 所以音量条得在这里直接画，否则只有 _vol_pop=True、屏上什么都没有。
                self._draw_volume_popup(self._mute_x)
            else:
                self._layout()
        self.canvas.tag_raise("volpop")   # 最后再抬一次，压住后画的东西


    def _schedule_hide_volume(self, _event=None) -> None:
        # 给 250ms 缓冲：人从 ♪ 挪到条子上是会短暂离开 ♪ 的，
        # 立刻收的话根本够不着滑块（这是所有 hover 菜单都要处理的那点缝）。
        # **必须走 `self.root.after`**：LiveGlass 不是 Tk 对象，`self.after` 不存在，
        # 写错的那一版每次收起都抛 AttributeError —— 表现正是"移开鼠标也不收起"。
        if self._vol_hide_job:
            return
        self._vol_hide_job = self.root.after(250, self._hide_volume_now)

    def _pointer_in(self, rects) -> bool:
        """鼠标是不是还落在这些区域里（窗口坐标）。"""
        try:
            px, py = self.root.winfo_pointerxy()
            x = px - self.root.winfo_rootx()
            y = py - self.root.winfo_rooty()
        except Exception:
            return False
        for x0, y0, x1, y1 in rects:
            if x0 - 2 <= x <= x1 + 2 and y0 - 2 <= y <= y1 + 2:
                return True
        return False

    def _hide_volume_now(self) -> None:
        self._vol_hide_job = None
        if self._vol_drag:
            return
        if not self._vol_pop:
            return
        # 收之前再看一眼指针：正好停在面板/♪ 上就别收（Leave 事件在快速移动时会漏）
        mx = self._mute_anchor()
        mute_rect = (mx - 16, 38 - 16, mx + 16, 38 + 16)
        if self._pointer_in([self._volume_rect(mx), mute_rect]):
            self._schedule_hide_volume()
            return
        self._vol_pop = False
        self._layout()

    def _toggle_mute_click(self) -> None:
        """点标题栏「♪」：静音 / 恢复（拖音量条才是主入口）。"""
        self.toggle_mute()

    def _set_volume(self, value: int) -> None:
        want = max(0, min(100, int(value)))
        st = dict(self._status)
        if want == st.get("volume"):
            return
        st["volume"] = want
        st["muted"] = want <= 0      # 兼容老读法
        self._status = st
        write_config({"status": st})
        self._layout()
        self._report("volume", value=want)

    def _vol_press(self, event) -> None:
        self._vol_drag = True
        self._set_volume(self._volume_at(event.y, self._mute_anchor()))

    def _vol_move(self, event) -> None:
        if self._vol_drag:
            self._set_volume(self._volume_at(event.y, self._mute_anchor()))

    def _vol_release(self, _event=None) -> None:
        self._vol_drag = False
        self._schedule_hide_volume()


    def _state_line(self) -> str:
        """标题栏中间那一行：陪看状态 · 焦点 · 要不要自动续看。

        这三件事全在宿主那边（`watch-window.json` 的 `status` 段）—— 窗口只管画。
        用语的来历（用户原话）：DSH 抢走焦点时他不要看到"你在用 DSH 了，我先停下"
        这种解释句，只要「焦点DSH，暂停」；恢复时只要「陪看中」。
        """
        st = self._status
        resume = "已开启恢复陪看" if st.get("resume") else "未开启恢复陪看"
        if st.get("pausedByFocus"):
            return f"焦点DSH，暂停 · {resume}"
        focus = "DSH" if st.get("focused") else "别处"
        if st.get("watching"):
            return f"陪看中 · 焦点：{focus} · {resume}"
        return f"没在陪看 · 焦点：{focus} · {resume}"

    # ---- 小悬浮窗（mini）----

    MINI_R = 20              # 圆按钮半径
    MINI_XS = (56, 116, 176)  # 三列的圆心 x
    MINI_YS = (39, 103)      # 两排的圆心 y
    MINI_EDGE = 18           # 距屏幕边缘这么近就算"贴边"
    MINI_HIDE_AFTER = 3.0    # 秒；贴着屏幕边且没人管，就往屏幕外挪一半

    def _mini_circle(self, key: str, cx: int, cy: int, glyph: str, tone: str,
                     *, active: bool = False) -> None:
        c = self.canvas
        r = self.MINI_R
        tags = ("minibtn", f"mini-{key}")
        photo = self._button_photo(key, r, tone, active)
        item = c.create_image(cx, cy, image=photo, tags=tags)
        try:
            if not hasattr(self, "_btn_items"):
                self._btn_items, self._btn_centers = {}, {}
            self._btn_items[key] = item
            self._btn_centers[key] = (cx, cy)
        except Exception:
            pass
        if key != "mic":
            self.text.draw(cx, cy, glyph, anchor="center", fill=tone, size=15, bold=True,
                           tags=tags)
        self._mini_btns[key] = (cx - r, cy - r, cx + r, cy + r)

    def _draw_mini(self) -> None:
        """小悬浮窗（用户手绘的版式）：**一块面板 + 下面两个圆**。

        面板里两行：
        - 上行：♪ 弹 ↘ ✕（和大窗右边那排同样的图标，均分）；
        - 下行：● 正在陪看 | 焦点·XX  + 3 号圆。
        面板下面（透明区）：麦 / T 两个圆，和**大窗完全一样**的样式；
        所有按钮的功能也和大窗一一对应。
        """
        c = self.canvas
        w = self._geo.width
        # **先清干净再画**：切档/重画时上一档留下的 item（大窗标题栏、折叠条、
        # 甚至上一版小窗）会以不同的 y 叠在同一块面板里 —— 那就是"两套正在陪看"。
        bg = getattr(self, "_bg", None)
        for item in c.find_all():
            if item != bg:
                c.delete(item)
        try:
            self.text.reset()
        except Exception:
            pass
        self._mini_btns = {}
        vol = int(self._status.get("volume") or 0)
        mic_on = self._mic_proc is not None and self._mic_proc.poll() is None
        dm_on = danmaku_wanted()
        watch_on = bool(self._status.get("watching"))
        resume = bool(self._status.get("resume"))
        focus = "DSH" if self._status.get("focused") else "别处"

        # ---- 顶部那条装饰线：和大窗一样，也是"拖着挪窗口"的把手 ----
        bar_len = max(72, int((w - SLAB_OUT * 2) * BAR_FRAC))
        c.create_line(w // 2 - bar_len // 2, BAR_Y, w // 2 + bar_len // 2, BAR_Y,
                      width=BAR_THICK, fill="#b8cbe0", capstyle="round",
                      tags=("minibt", "topbar"))
        # ---- 上行：五个图标，均分面板宽度 ----
        y_icons = 12 + 34
        margin = SLAB_OUT + 16
        slot = (w - margin * 2) / 5.0

        def ix(i: int) -> float:
            return margin + slot * (i + 0.5)

        # 小窗的 ♪ 也挂上 "mute" tag，和大窗共用音量展开的绑定
        self._mute_x = int(ix(0))
        self.text.draw(ix(0), y_icons, "♪", anchor="center",
                       fill="#7fc4ff" if vol > 0 else "#55637a", size=16,
                       tags=("minibt", "mute"))
        self._mini_btns["mute"] = (ix(0) - slot / 2, y_icons - 16, ix(0) + slot / 2, y_icons + 16)
        if vol <= 0:
            c.create_line(ix(0) - 6, y_icons - 8, ix(0) + 6, y_icons + 6, fill="#e05a5a",
                          width=1.6, tags=("minibt",))
        self.text.draw(ix(1), y_icons, "弹", anchor="center",
                       fill="#7fc4ff" if dm_on else "#55637a", size=14, tags=("minibt",))
        self._mini_btns["danmaku"] = (ix(1) - slot / 2, y_icons - 16, ix(1) + slot / 2, y_icons + 16)
        self.text.draw(ix(2), y_icons, "↘", anchor="center", fill="#8fa0b8", size=18,
                       tags=("minibt",))
        self._mini_btns["expand"] = (ix(2) - slot / 2, y_icons - 16, ix(2) + slot / 2, y_icons + 16)
        # 💬 气泡开关：Tk 在 Windows 上画不出彩色 emoji，用画布的线和圆角拼一个
        self._draw_bubble_icon(c, ix(3), y_icons,
                               self._icon_tone(ix(3), y_icons) if self._bubbles_on
                               else "#55637a")
        self._mini_btns["bubbles"] = (ix(3) - slot / 2, y_icons - 16,
                                      ix(3) + slot / 2, y_icons + 16)
        self.text.draw(ix(4), y_icons, "✕", anchor="center", fill="#9fb0c8", size=15,
                       tags=("minibt",))
        self._mini_btns["close"] = (ix(4) - slot / 2, y_icons - 16, ix(4) + slot / 2, y_icons + 16)

        # ---- 下行：状态 + 焦点 + 3 号圆 ----
        # 间距**照抄大窗标题栏**：点 → +14 → 标题 → +8 → 「|」→ +10 → 焦点 → +10+r → 圆。
        # 以前是把「焦点」右对齐到圆，中缝被撑得很开（用户说"太远了"）。
        y2 = 12 + 68
        dot_cx = SLAB_OUT + 22                 # 大窗里是 34
        c.create_oval(dot_cx - 5, y2 - 5, dot_cx + 5, y2 + 5, fill="#0a84ff", outline="")
        x = float(dot_cx + 14)                 # 大窗里 title_x = 48
        label = "正在陪看" if watch_on else "已暂停"
        self.text.draw(x, y2, label, anchor="w",
                       fill="#f7fbff" if watch_on else "#ffc48a", size=13, bold=True,
                       tags=("minibt",))
        lw = self.fonts.get(13, True).measure("正在陪看")   # 固定宽度，2/3 号不许挪
        self._mini_btns["watch"] = (x - 4, y2 - 14, x + lw + 4, y2 + 14)
        x += lw + 8
        self.text.draw(x, y2, "|", anchor="w", fill="#4a5a70", size=12, tags=("minibt",))
        x += 10
        ftxt = f"焦点·{focus}"
        self.text.draw(x, y2, ftxt, anchor="w",
                       fill="#5fdc9a" if resume else "#ff8a8a", size=12, bold=True,
                       tags=("minibt",), adapt=False)
        fw = self.fonts.get(12, True).measure(ftxt)
        self._mini_btns["resume"] = (x - 4, y2 - 14, x + fw + 4, y2 + 14)
        r = 11.0
        b3x = min(x + fw + 10 + r, w - SLAB_OUT - 12 - r)   # 太靠右就夹进面板
        if self._btn3:
            bar_h = 9.0
            self._round_rect(c, x - 2, y2 - bar_h / 2, b3x + 1, y2 + bar_h / 2,
                             bar_h / 2, self.BTN3_RED, tags=("minibt",))
        c.create_oval(b3x - r, y2 - r, b3x + r, y2 + r, fill=self.BTN3_RED if self._btn3
                      else self.BTN3_GREEN, outline="", tags=("btn3mini",))
        self._mini_btn3 = (b3x, y2, r)

        # ---- 面板下面：两个和**大窗一模一样**的圆 ----
        (tcx, cy), (mcx, _cy2), _cy3 = self._mini_input_points()
        self._input_circle("text", tcx, cy, "T", "#eaf4ff",
                           active=getattr(self, "_text_popup", None) is not None)
        holding = bool(getattr(self, "_mic_hold", False))
        # **只有两种状态**：正在收音（按住说话也算）＝橙；静默＝默认不动
        mic_state = "recording" if (mic_on or holding) else "idle"
        self._input_circle("mic", mcx, cy, "T",
                           "#ffb4b4" if (mic_on or holding) else "#cfe0f5",
                           active=mic_state != "idle", state=mic_state)
        self._mini_hit_mic = (mcx, cy, self.INPUT_BTN_R)
        self._mini_hit_text = (tcx, cy, self.INPUT_BTN_R)
        self._mini_input = (tcx, cy, mcx, cy)
        # **小窗每次重排都要把音量条补回来**：
        # 点一下音量条会触发重排，画布被清空 → 条子消失但拖拽还在改音量（用户实报）。
        if getattr(self, "_vol_pop", False):
            try:
                self._draw_volume_popup(self._mute_x)
                self.canvas.tag_raise("volpop")
            except Exception:
                pass


    def _mini_btns_box(self) -> tuple:
        """小窗两个圆的外接框（不依赖 `_geo`，给小窗玻璃建几何用）。

        **宽度必须用 `MINI_W` 常量**：`_enter_mini` 建几何那一刻 `self._geo`
        还是大窗的尺寸，拿它算会把玻璃垫算到大窗坐标上 —— 窗口在右半边时
        坐标直接越界被 `mini_slabs` 拒绝，两个圆就成了"没有玻璃、纯透明"。
        """
        w = MINI_W
        r = self.INPUT_BTN_R
        cy = 12 + MINI_PANEL_H + MINI_GAP + 24
        gap = r * 2 + 8
        left = (getattr(self, "_side_cache", None) or "left") == "left"
        if left:
            mcx = SLAB_OUT + 16 + r
            tcx = mcx + gap
        else:
            tcx = w - SLAB_OUT - 16 - r
            mcx = tcx - gap
        return (min(tcx, mcx) - r, cy - r, max(tcx, mcx) + r, cy + r)

    def _mini_input_points(self) -> tuple:
        """小窗下面那两个圆的圆心：(T, 麦, 中线 y)。

        和大窗同一套规则：窗口在屏幕左半边 → 靠左下角；在右半边 → 靠右下角。
        """
        w = self._geo.width
        r = self.INPUT_BTN_R
        cy = 12 + MINI_PANEL_H + MINI_GAP + 24
        gap = r * 2 + 8
        left = self._input_side() == "left"
        # 和大窗同一套：**麦在左、T 在右**，两个作为一组整体贴边
        if left:
            mcx = SLAB_OUT + 16 + r
            tcx = mcx + gap
        else:
            tcx = w - SLAB_OUT - 16 - r
            mcx = tcx - gap
        return (tcx, cy), (mcx, cy), cy

    def _mini_hit(self, x: int, y: int):
        hit3 = getattr(self, "_mini_btn3", None)
        if hit3 and (x - hit3[0]) ** 2 + (y - hit3[1]) ** 2 <= (hit3[2] + 2) ** 2:
            return "btn3"
        for key, (bx0, by0, bx1, by1) in self._mini_btns.items():
            if bx0 <= x <= bx1 and by0 <= y <= by1:
                return key
        return None

    def _adapt_input_buttons(self) -> None:
        """每帧刷新两个输入圆：玻璃底跟着帧走、图标跟着明暗走。

        节流 100ms：重建两张 46px 小图不算贵，但没必要每帧都做。
        """
        # 采样图已停用，但**图标的明暗要每帧跟着背景变**（T 是文字层自动变的，
        # 麦克风是图片，不刷新就会一直是画上去时的那个颜色）。
        item = getattr(self, "_mic_item", None)
        center = getattr(self, "_mic_center", None)
        if item is None or not center:
            return
        try:
            tone = self._icon_tone(center[0], center[1])
            if tone == getattr(self, "_mic_tone", None):
                return
            self._mic_tone = tone
            r = int(self.INPUT_BTN_R)
            size = r * 2
            glyph_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            d = ImageDraw.Draw(glyph_img)
            self._mic_into(d, size / 2.0, size / 2.0 - 2.5, r / 20.0 * 1.15, tone)
            photo = ImageTk.PhotoImage(glyph_img, master=self.canvas)
            self._bare_icons["mic"] = photo
            self.canvas.itemconfigure(item, image=photo)
        except Exception:
            pass
        return
        if self._glass_style not in ("live", "auto"):
            return
        now = __import__("time").time()
        if now - getattr(self, "_btn_upd", 0.0) < 0.0:   # 每帧都重采样
            return
        self._btn_upd = now
        items = getattr(self, "_btn_items", None) or {}
        centers = getattr(self, "_btn_centers", None) or {}
        for key, item in items.items():
            pos = centers.get(key)
            if not pos:
                continue
            try:
                photo = self._glass_circle_photo(key, pos[0], pos[1])
                if photo is not None:
                    self.canvas.itemconfigure(item, image=photo)
            except Exception:
                pass

    @staticmethod
    def _coerce_frame(frame):
        """抓屏可能给 float32/其它 dtype，PIL 只吃 uint8 —— 这里统一兜住。"""
        try:
            import numpy as np
            if isinstance(frame, Image.Image):
                return frame.convert("RGB")
            arr = np.asarray(frame)
            if arr.dtype != np.uint8:
                if arr.dtype.kind == "f" and float(arr.max(initial=0)) <= 1.0:
                    arr = (arr * 255.0).clip(0, 255)
                arr = arr.astype("uint8")
            if arr.ndim == 2:
                return Image.fromarray(arr, "L").convert("RGB")
            return Image.fromarray(arr[:, :, :3], "RGB")
        except Exception:
            return frame

    def _adapt_bubble_icon(self) -> None:
        """每帧跟着文字一起换气泡图标的颜色（慢一拍就是这里缺了刷新）。"""
        info = getattr(self, "_bubicon", None)
        if not info or not getattr(self, "_bubbles_on", True):
            return
        it1, it2, cx, cy = info
        color = self._icon_tone(cx, cy)
        if color == getattr(self, "_bubicon_tone", None):
            return
        self._bubicon_tone = color
        try:
            self.canvas.itemconfigure(it1, outline=color)
            self.canvas.itemconfigure(it2, fill=color)
        except Exception:
            pass

    def _icon_tone(self, cx: float, cy: float, half: int = 14) -> str:
        """画布图形没法用文字层的 `adapt()`，这里自己按背景亮度选色。

        规则和 `adapt()` 一致：背后偏亮 → 用深色图标；偏暗 → 用浅色图标。
        取不到帧就退回浅色（小窗面板基本是深色）。
        """
        light, dark = "#dfeaf7", "#12202f"
        frame = getattr(self, "_last_frame", None)
        if frame is None:
            return light
        # **每帧只算一次**：气泡图标和麦克风图标在同一帧里各调一次，
        # 缓存按 (帧对象, 坐标) 命中，省掉重复的裁剪 + 中位数。
        cache = getattr(self, "_tone_cache", None)
        key = (id(frame), int(cx), int(cy))
        if cache is not None and cache[0] == key:
            return cache[1]
        try:
            import numpy as np
            box = (int(cx - half), int(cy - half), int(cx + half), int(cy + half))
            if box[0] < 0 or box[1] < 0 or box[2] > frame.width or box[3] > frame.height:
                return light
            crop = frame.crop(box).convert("L")
            color = dark if float(np.median(np.asarray(crop))) / 255.0 >= 0.55 else light
            self._tone_cache = (key, color)
            return color
        except Exception:
            pass
        return light

    def _draw_bubble_icon(self, c, cx: float, cy: float, color: str) -> None:
        """💬 那个形状：圆角气泡 + 左下角一个小尾巴（Tk 没有可靠的 emoji 字形）。"""
        try:
            pts = self._rounded_points(cx - 11, cy - 9, cx + 11, cy + 5, 5)
            it1 = c.create_polygon(pts, smooth=False, fill="", outline=color, width=1.6,
                                   tags=("minibt", "bubicon"))
            it2 = c.create_polygon(cx - 7, cy + 4, cx - 1, cy + 4, cx - 7, cy + 11,
                                   fill=color, outline="", tags=("minibt", "bubicon"))
            self._bubicon = (it1, it2, cx, cy)
        except Exception:
            pass

    def _toggle_bubbles(self) -> None:
        """气泡开关：关掉就立刻收掉已经浮着的气泡，并写盘记住。"""
        self._bubbles_on = not getattr(self, "_bubbles_on", True)
        self._auto_at = time.time()
        try:
            write_config({"bubbles": bool(self._bubbles_on)})
        except Exception:
            pass
        if not self._bubbles_on:
            try:
                self._mini_bubbles = []
                for win in list(getattr(self, "_bubble_wins", {}) or {}):
                    pass
                self._mini_bubble_clear()
            except Exception:
                pass
        try:
            self.canvas.delete("minibt")
            self.canvas.delete("inputbtn")
            self.canvas.delete("btn3mini")
            self._draw_mini()
            self.text.refresh()
        except Exception:
            pass

    def _mini_action(self, key: str) -> None:
        """小窗的按钮动作 —— 和大窗**完全同一套**（用户要求）。"""
        if key == "mute":
            self.toggle_mute()
        elif key == "danmaku":
            self.toggle_danmaku()
        elif key == "expand":
            self._apply_mode(MODE_FULL, save=True)
        elif key == "close":
            self._close()
        elif key == "mic":
            self._mic_press()
        elif key == "text":
            self._toggle_text_popup()
        elif key == "watch":
            self._toggle_watch_click()
        elif key == "resume":
            self._toggle_resume_click()
        elif key == "btn3":
            self._toggle_btn3()
        elif key == "bubbles":
            self._toggle_bubbles()

    # ---- 小窗的气泡（**只有小窗有**：大窗还是列表）----

    BUBBLE_W = 300          # 气泡窗宽度
    BUBBLE_FADE = 0.15      # 渐显时长
    POPUP_MIN_H = SLAB_TOP_H   # 单行高度（和标题栏同高）
    POPUP_PAD_L = 14   # 补回（前面重写时丢了）
    POPUP_PAD_R = 84   # 补回（前面重写时丢了）
    MINI_POPUP_W = 600   # 补回（前面重写时丢了）
    MINI_POPUP_MAX = 760   # 补回（前面重写时丢了）

    def _mini_bubble_clear(self) -> None:
        """收掉所有浮着的小窗气泡（关气泡开关时用）。"""
        self._mini_bubbles = []
        for win in list(getattr(self, "_bubble_wins", {}).values()):
            try:
                win.destroy()
            except Exception:
                pass
        try:
            self._bubble_wins = {}
        except Exception:
            pass
        try:
            self._draw_mini_bubbles()
        except Exception:
            pass

    def _mini_bubble_push(self, msgs) -> None:
        """新消息进小窗的气泡队列：最多 `bubbleMax` 条，下新上老，超了顶掉最老的。"""
        if not self._mini or not getattr(self, "_bubbles_on", True):
            return
        cap = max(1, min(3, int(self._ui["bubbleMax"])))
        now = time.time()
        added = False
        for m in msgs or ():
            key = self._msg_key(m)
            if any(b["key"] == key for b in self._mini_bubbles):
                continue
            self._mini_bubbles.append({"msg": m, "key": key, "born": now})
            added = True
        while len(self._mini_bubbles) > cap:
            self._mini_bubbles.pop(0)
        if added or self._mini_bubbles:
            self._draw_mini_bubbles()

    def _mini_bubble_tick(self) -> None:
        """到点的气泡退场（250ms 判一次，和 `_poll_chat` 同一个节奏）。"""
        if not self._mini:
            return
        stay = float(self._ui["bubbleStay"])
        if stay <= 0 or not self._mini_bubbles:
            return
        now = time.time()
        keep = [b for b in self._mini_bubbles if now - float(b["born"]) <= stay]
        if len(keep) != len(self._mini_bubbles):
            if self._bubble_expand_key not in [b["key"] for b in keep]:
                self._bubble_expand_key = None
            self._mini_bubbles = keep
            if keep:
                self._draw_mini_bubbles()
            else:
                self._close_bubble_win()

    def _ensure_bubble_win(self):
        if self._bubble_win is not None:
            return self._bubble_win
        top = tk.Toplevel(self.root)
        top.overrideredirect(True)
        top.attributes("-topmost", True)
        top.configure(bg=KEY)
        if IS_WIN:
            # 和主窗同一套抠色：只有气泡那块圆角是实的，其余全是洞
            top.attributes("-transparentcolor", KEY)
        c = tk.Canvas(top, width=self.BUBBLE_W, height=10, bg=KEY,
                      highlightthickness=0, bd=0)
        c.pack()
        self._bubble_win, self._bubble_canvas = top, c
        return top

    def _close_bubble_win(self) -> None:
        top, self._bubble_win = getattr(self, "_bubble_win", None), None
        self._bubble_canvas = None
        if top is not None:
            try:
                top.destroy()
            except Exception:
                pass

    @staticmethod
    def _rounded_points(x0, y0, x1, y1, r, steps: int = 7):
        """圆角矩形的多边形顶点：**按角度采样**，不是给四个角塞两个点。

        以前用 `smooth=True` + 12 个点糊，圆角会被插值成歪的（拖动骨架看着像方角）。
        按每个角 8 个采样点画出来，形状就是真的圆角。
        """
        import math
        r = max(0.0, min(float(r), (x1 - x0) / 2.0, (y1 - y0) / 2.0))
        pts = []
        for cx, cy, a0, a1 in (
            (x1 - r, y0 + r, -90, 0),
            (x1 - r, y1 - r, 0, 90),
            (x0 + r, y1 - r, 90, 180),
            (x0 + r, y0 + r, 180, 270),
        ):
            for i in range(steps + 1):
                a = math.radians(a0 + (a1 - a0) * i / steps)
                pts.extend([cx + r * math.cos(a), cy + r * math.sin(a)])
        return pts

    def _round_rect(self, c, x0, y0, x1, y1, r, fill, tags=()):
        pts = self._rounded_points(x0, y0, x1, y1, r)
        return c.create_polygon(pts, smooth=False, fill=fill, outline="",
                                tags=tags)

    def _bubble_pos(self, total_h: int) -> tuple:
        """气泡窗贴在**小窗旁边**：贴右边就放左边，否则放右边。"""
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        mx, my = self._mini_rest_pos(False)
        ex, _ey = getattr(self, "_mini_edge", (None, None))
        if ex == "right":
            x = mx - self.BUBBLE_W - 6
        elif ex == "left":
            x = mx + MINI_W + 6
        else:
            x = mx + MINI_W + 6
            if x + self.BUBBLE_W > vx + vw:
                x = mx - self.BUBBLE_W - 6
        y = my
        x = max(vx + 4, min(x, vx + vw - self.BUBBLE_W - 4))
        y = max(vy + 4, min(y, vy + vh - total_h - 4))
        return int(x), int(y)

    def _draw_mini_bubbles(self) -> None:
        """画小窗的气泡：下新上老、按文字量定高、超 150 字「……」、点一下看全文。

        这是一扇**独立的小窗**（和小球并排），所以小窗本身还是那两条胶囊，
        消息不会把它撑大。大窗完全不参与这套。
        """
        if not self._mini or not self._mini_bubbles:
            self._close_bubble_win()
            return
        try:
            top = self._ensure_bubble_win()
        except Exception as exc:
            print("bubble win failed", repr(exc), flush=True)
            return
        c = self._bubble_canvas
        c.delete("all")
        size = max(9, int(self._ui["fontSize"]))
        font = self.fonts.get(size)
        pad = 10
        wrap = self.BUBBLE_W - 2 * pad - 6
        now = time.time()
        infos = []
        y = 6
        for b in self._mini_bubbles:
            raw = str(b["msg"].get("text") or "")
            expanded = self._bubble_expand_key == b["key"]
            clipped = len(raw) > BUBBLE_CHARS
            text = raw if expanded else (raw[:BUBBLE_CHARS] + "……" if clipped else raw)
            fade = min(1.0, max(0.0, (now - float(b["born"])) / self.BUBBLE_FADE))
            fill = self._ui["fontColor"]
            item = c.create_text(pad + 3, y + pad, text=text, anchor="nw", width=wrap,
                                 font=font, fill=fill, tags=("bub",))
            bb = c.bbox(item)
            th = max(font.metrics("linespace"), (bb[3] - bb[1]) if bb else 0)
            h = th + 2 * pad
            infos.append({"y": y, "h": h, "key": b["key"],
                          "toggle": clipped or expanded, "expanded": expanded, "font": font})
            y += h + 6
        total = y + 2
        for it in infos:
            # **单层气泡**（两层版本在气泡窗口上画不出来，回退到这一条稳的路径）：
            # 颜色由 `_bubble_fill()` 决定 —— 跟随大窗时给玻璃色调，否则给自定义色。
            rect = self._round_rect(c, 1, it["y"], self.BUBBLE_W - 1,
                                    it["y"] + it["h"], 11, self._bubble_fill())
            # 底板压到文字下面（不压会盖住字；压过头会连同背景一起消失 —— 这里只压底板）
            c.tag_lower(rect)
            if it["toggle"]:
                c.create_text(self.BUBBLE_W - 14, it["y"] + it["h"] - 12,
                              text="▴" if it["expanded"] else "▾",
                              fill="#9fc7ff", font=it["font"], tags=("bub",))
        # **把文字提到最上层**：底板是后画的，会把先画的文字盖住（用户实报看不到字）
        c.tag_raise("bub")
        x, wy = self._bubble_pos(total)
        try:
            top.geometry(f"{self.BUBBLE_W}x{total}+{x}+{wy}")
            c.configure(height=total)
        except Exception:
            pass

        def on_click(e, infos=infos):
            for it in infos:
                if it["y"] - 2 <= e.y <= it["y"] + it["h"] + 2:
                    if it["expanded"]:
                        self._bubble_expand_key = None
                    else:
                        self._bubble_expand_key = it["key"]
                    self._draw_mini_bubbles()
                    return "break"
            return None

        c.bind("<Button-1>", on_click)
        # 还有气泡在渐显：60ms 后再画一帧
        if any(now - float(b["born"]) < self.BUBBLE_FADE for b in self._mini_bubbles):
            self.root.after(60, self._draw_mini_bubbles)

    # ---- 贴边吸附 / 半藏 ----

    def _mini_edge_of(self):
        """mini 贴着屏幕哪两条边（不在边缘就是 (None, None)）。"""
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        x, y = self.root.winfo_x(), self.root.winfo_y()
        d = self.MINI_EDGE
        ex = "left" if abs(x - vx) <= d else ("right" if abs(vx + vw - (x + MINI_W)) <= d else None)
        ey = "top" if abs(y - vy) <= d else ("bottom" if abs(vy + vh - (y + MINI_H)) <= d else None)
        return ex, ey

    def _mini_snap(self) -> None:
        """进小悬浮窗：靠近屏幕边缘就吸上去，并记住贴的是哪条边。"""
        ex, ey = self._mini_edge_of()
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        x, y = self.root.winfo_x(), self.root.winfo_y()
        if ex == "left":
            x = vx
        elif ex == "right":
            x = vx + vw - MINI_W
        if ey == "top":
            y = vy
        elif ey == "bottom":
            y = vy + vh - MINI_H
        same = (int(self._x) == int(x) and int(self._y) == int(y)
                and self.root.winfo_x() == int(x) and self.root.winfo_y() == int(y))
        self._x, self._y = int(x), int(y)
        self._mini_edge = (ex, ey)
        self._mini_peeked = False
        self._mini_last_mouse = time.time()
        # **已经在那儿了就别再调**：每次 `root.geometry()` 都是一次真实的窗口移动，
        # 定时器反复调就会看到"窗自己一直在刷新位置"。
        if not same:
            self.root.geometry(f"+{self._x}+{self._y}")
        # 气泡窗跟在小球旁边：拖完吸边之后位置变了，得重画一次
        if self._mini_bubbles:
            self._draw_mini_bubbles()

    def _mini_rest_pos(self, hidden: bool) -> tuple:
        """贴边半藏时窗口该在哪。不在边上就直接返回当前可见位置。"""
        x, y = self._x, self._y
        ex, ey = getattr(self, "_mini_edge", (None, None))
        if not hidden:
            return x, y
        half_w, half_h = MINI_W // 2, MINI_H // 2
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        if ex == "left":
            x = vx - half_w
        elif ex == "right":
            x = vx + vw - MINI_W + half_w
        if ey == "top":
            y = vy - half_h
        elif ey == "bottom":
            y = vy + vh - MINI_H + half_h
        return x, y

    def _mini_glide(self, hidden: bool, steps: int = 5) -> None:
        """**贴边滑入/滑出已移除**：空实现，留给老调用点。"""
        return

    def _popup_limits(self) -> tuple:
        """(基准宽, 最大宽)。

        - 大窗：和主体同宽，**不跟着变**（用户手绘图：长度和位置对齐）；
        - 小窗：固定 300 起步，文字一行放不下时先变宽，到 460 封顶后换行。
        """
        if self._mini:
            return self.MINI_POPUP_W, self.MINI_POPUP_MAX
        body = max(240, int(self._geo.width) - 2 * SLAB_OUT)
        return body, body

    def _popup_text_value(self) -> str:
        txt = getattr(self, "_popup_text", None)
        if txt is None:
            return ""
        try:
            return txt.get("1.0", "end-1c")
        except Exception:
            return ""

    def _popup_metrics(self) -> tuple:
        """按当前文字算输入条该多大：先用一行量宽度，装不下就变宽，再装不下就换行加高。"""
        base_w, max_w = self._popup_limits()
        fs = max(11, int(self._ui["fontSize"]))
        font = self.fonts.get(fs)
        ls = max(1, font.metrics("linespace"))
        text = self._popup_text_value()
        paras = text.split("\n") or [""]
        widest = max([0] + [font.measure(p) for p in paras])
        avail_min = max(60, base_w - self.POPUP_PAD_L - self.POPUP_PAD_R)
        # 一行放得下 → 基准宽；放不下 → 先长宽，长到 max_w 还放不下就老实换行
        w = base_w
        if widest + self.POPUP_PAD_L + self.POPUP_PAD_R > base_w:
            w = min(max_w, widest + self.POPUP_PAD_L + self.POPUP_PAD_R)
        avail = max(60, w - self.POPUP_PAD_L - self.POPUP_PAD_R)
        lines = 0
        for p in paras:
            lines += max(1, -(-font.measure(p) // avail))      # 向上取整
        h = max(self.POPUP_MIN_H, lines * ls + 18)
        # 太高就别再长了（Text 自己会滚）
        h = min(h, 200)
        return int(w), int(h)

    def _popup_gap(self) -> int:
        """弹条和按钮之间的距离。

        用户要求「边缘位置距离按钮近一些，大约和按钮距离历史信息框的距离相同」——
        那个距离就是主体下沿到圆按钮顶端的这一截（16px 左右），这里直接量出来。
        """
        try:
            body_bottom = self._geo.slabs[1][3]   # 主体下沿（最后一块是按钮窄玻璃）
            _t, _m, cy = self._input_points()
            return max(8, int(cy - self.INPUT_BTN_R - body_bottom))
        except Exception:
            return 14

    def _popup_pos(self, w: int, h: int) -> tuple:
        """贴在按钮下面，间距和按钮到消息框的间距一样；下面放不下就翻到上面。"""
        vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
        wx = self.root.winfo_x()
        wy = self.root.winfo_rooty()
        gap = self._popup_gap()
        if self._mini:
            # 小窗：整条挂在窗口**下面**（下面放不下就翻到上面），保证完全可见、
            # 不压住面板里的按钮（用户要求：类似大窗逻辑，放上面或下面）
            x = wx + SLAB_OUT
            # 下面那条：贴到**两个圆按钮的底边**，不要从整个窗口底边算 ——
            # 窗口底部还有一段透明区，从那儿算出来会离得很远（用户说太远了）。
            try:
                _t, _m, icy = self._mini_input_points()
            except Exception:
                icy = int(self._geo.height) - 24
            y = wy + int(icy + self.INPUT_BTN_R + 6)
            if y + h > vy + vh:
                # 翻到上面时保持原来的距离（用户说上方那段距离合格）
                y = wy - h - 8
            x = max(vx + 4, min(x, vx + vw - w - 4))
            y = max(vy + 4, min(y, vy + vh - h - 4))
            return int(x), int(y)
        try:
            _t, _m, cy = self._input_points()
        except Exception:
            cy = int(self._geo.height) - 53
        x = wx + SLAB_OUT
        y = wy + int(cy + self.INPUT_BTN_R + gap)
        if y + h > vy + vh:
            # **下面放不下就翻到整个窗口上方**。
            # 原来减的是"按钮圆心"，算出来落在窗口内部（历史区与按钮之间），
            # 正是用户报的"输入框卡在中间"。
            y = wy - h - 8
            if y < vy + 4:
                y = vy + 4
        x = max(vx + 4, min(x, vx + vw - w - 4))
        y = max(vy + 4, min(y, vy + vh - h - 4))
        return int(x), int(y)

    def _bubble_fill(self) -> str:
        """气泡底色：设置的「气泡颜色」按「气泡透明度」向窗底收敛。

        canvas 画不了半透明，所以先把颜色和底衬按 alpha 混成一个实色 ——
        这样预览里看到的浓淡和窗口里一致。
        """
        base = str(self._ui.get("bubbleColor") or "#07111d")
        try:
            a = max(0.0, min(1.0, float(self._ui.get("bubbleOpacity") or 1.0)))
        except Exception:
            a = 1.0
        try:
            r = int(base[1:3], 16)
            g = int(base[3:5], 16)
            b = int(base[5:7], 16)
        except Exception:
            r, g, b = 7, 17, 29
        # 往"窗底"混：alpha 越低越接近底色
        br, bg2, bb = 11, 18, 32
        mix = lambda c, d: int(round(d + (c - d) * a))
        return f"#{mix(r, br):02x}{mix(g, bg2):02x}{mix(b, bb):02x}"

    def _popup_glass_tint(self) -> str:
        """输入条的底色：取当前玻璃帧里**离输入条最近的那块**的平均色。

        这样它和主窗口的玻璃是一家的；而且这层是画在输入条自己的 Toplevel 里，
        输入条一关整个窗口销毁 —— 不会留下"玻璃还在"的残影。
        """
        fallback = self._style_colors()[2]
        frame = getattr(self, "_last_frame", None)
        if frame is None:
            return fallback
        try:
            import numpy as np
            w, h = frame.size
            # 取底边中段一条：那是最靠近输入条区域的地方
            # 只取 32x16 的一小块，够代表色调，速度比整条快一个数量级
            cx0 = max(0, int(w * 0.5) - 16)
            cy0 = max(0, min(h - 16, int(h * 0.82)))
            box = (cx0, cy0, min(w, cx0 + 32), min(h, cy0 + 16))
            if box[2] - box[0] < 8 or box[3] - box[1] < 8:
                return fallback
            arr = np.asarray(frame.crop(box).convert("RGB")).reshape(-1, 3)
            r, g, b = (int(v) for v in arr.mean(axis=0))
            return f"#{r:02x}{g:02x}{b:02x}"
        except Exception:
            return fallback

    def _popup_plate(self, w: int, h: int):
        """输入条的玻璃底板：**和主窗口同一套风格**。

        - `solid` → 纯色底板；
        - `frost` → 预生成磨砂底板；
        - `live`  → 抓输入条位置后面的一小块桌面，高斯糊 + 压暗，看起来是同一块玻璃。
        外面包圆角遮罩、抠色键，贴到输入条 Toplevel 的 Canvas 上当背景。
        """
        from glass_static import frost_base
        style = str(getattr(self, "_style", "") or "live")
        try:
            if style == "solid" or self._solid:
                base = Image.new("RGB", (w, h), (18, 22, 30))
            elif style == "frost" or self._static:
                base = frost_base(w, h)
            else:
                base = self._popup_live_plate(w, h)
        except Exception:
            try:
                base = frost_base(w, h)
            except Exception:
                base = Image.new("RGB", (w, h), (18, 22, 30))
        try:
            mask = Image.new("L", (w * 4, h * 4), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                (0, 0, w * 4, h * 4), radius=SLAB_RADIUS * 4, fill=255)
            mask = mask.resize((w, h), Image.Resampling.LANCZOS)
            mask = mask.point(lambda v: 255 if v >= 128 else 0)
            out = Image.new("RGB", (w, h), KEY)
            out.paste(base, (0, 0), mask)
            return out
        except Exception:
            return base

    def _popup_live_plate(self, w: int, h: int):
        """live 样式：抓输入条正后方的一小块桌面，糊成玻璃。"""
        import mss
        x, y = self._popup_pos(w, h)
        pad = 24
        gl = max(int(self._vx), int(x) - pad)
        gt = max(int(self._vy), int(y) - pad)
        gr = min(int(self._vx) + int(self._vw), int(x) + w + pad)
        gb = min(int(self._vy) + int(self._vh), int(y) + h + pad)
        if gr - gl <= 0 or gb - gt <= 0:
            raise ValueError("popup 区域不合法")
        with mss.mss() as sct:
            shot = sct.grab({"left": gl, "top": gt, "width": gr - gl, "height": gb - gt})
        im = Image.frombytes("RGB", shot.size, shot.rgb)
        ox, oy = int(x) - gl, int(y) - gt
        im = im.crop((ox, oy, ox + w, oy + h))
        small = im.resize((max(2, w // 4), max(2, h // 4)), Image.Resampling.BILINEAR)
        blur = small.filter(ImageFilter.GaussianBlur(4)).resize((w, h), Image.Resampling.BILINEAR)
        arr = np.asarray(blur).astype(np.float32) * 0.40 + np.array([8.0, 14.0, 22.0])
        return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

    def _popup_paint(self) -> None:
        """把玻璃底板画到输入条的 Canvas 上（Text 和「发送」浮在它上面）。"""
        c = getattr(self, "_popup_canvas", None)
        if c is None:
            return
        try:
            w = int(getattr(self, "_popup_w", self.POPUP_MIN_H))
            h = int(getattr(self, "_popup_h", self.POPUP_MIN_H))
            c.delete("popup_bg")
            img = ImageTk.PhotoImage(self._popup_plate(w, h), master=c)
            c.create_image(0, 0, anchor="nw", image=img, tags=("popup_bg",))
            c.tag_lower("popup_bg")
            self._popup_bg_img = img      # 防 PhotoImage 被 GC 成透明
            # 文字区底色跟着风格走：和底板同一色调，玻璃露出来的部分才不割裂
            try:
                t = getattr(self, "_popup_text", None)
                if t is not None:
                    t.configure(bg=self._style_colors()[2])
            except Exception:
                pass
        except Exception:
            # 底板画不出来就退回原来的纯色圆角（输入条照样能用）
            try:
                self._round_rect(c, 1, 1, w - 1, h - 1, SLAB_RADIUS, self._popup_glass_tint())
            except Exception:
                pass

    def _relayout_text_popup(self) -> None:
        """重算尺寸 + 位置 + 重画底板。文字变了、主窗动了/被拉大了都走这里。"""
        top = getattr(self, "_text_popup", None)
        if top is None:
            return
        try:
            w, h = self._popup_metrics()
            x, y = self._popup_pos(w, h)
            top.geometry(f"{w}x{h}+{x}+{y}")
            c = getattr(self, "_popup_canvas", None)
            if c is not None:
                c.configure(width=w, height=h)
                c.delete("all")
                # **先记住新尺寸再画垫片**：_popup_paint 按 _popup_w/_popup_h 取底板，
                # 顺序反了第一次会拿上一档尺寸（54×54）画一张小垫片贴在左上角
                self._popup_w, self._popup_h = w, h
                self._popup_paint()
                avail = max(80, w - self.POPUP_PAD_L - self.POPUP_PAD_R)
                if self._popup_text is not None:
                    # 单行时把文字垂直居中（Text 默认从顶部开始写，看起来偏上）
                    try:
                        lh = self.fonts.get(max(11, int(self._ui["fontSize"]))).metrics("linespace")
                        hh = max(22, h - 16)          # 控件实际高度（见下面 create_window）
                        pad_y = max(0, (hh - lh) // 2)   # 上下均分，且不会超出控件
                        self._popup_text.configure(pady=pad_y)
                    except Exception:
                        pass
                    c.create_window(self.POPUP_PAD_L, h // 2, window=self._popup_text,
                                    anchor="w", width=avail, height=max(22, h - 16))
                send = c.create_text(w - 16, h // 2, text="发送", anchor="e",
                                     fill="#9fc7ff", font=self.fonts.spec(11, True))
                c.tag_bind(send, "<Button-1>", lambda _e: self._send_popup())
                c.tag_bind(send, "<Enter>",
                           lambda _e: c.itemconfigure(send, fill="#d6e8ff"))
                c.tag_bind(send, "<Leave>",
                           lambda _e: c.itemconfigure(send, fill="#9fc7ff"))
        except Exception as exc:
            print("popup relayout failed", repr(exc), flush=True)

    def _move_text_popup(self) -> None:
        """只挪位置（拖主窗时用）：不重量文字，省得每动一像素量一次。"""
        top = getattr(self, "_text_popup", None)
        if top is None:
            return
        try:
            w = int(getattr(self, "_popup_w", self.POPUP_MIN_H))
            h = int(getattr(self, "_popup_h", self.POPUP_MIN_H))
            x, y = self._popup_pos(w, h)
            top.geometry(f"+{x}+{y}")
            # live 玻璃要跟着新位置重新抓背景；frost/solid 不用（底板和位置无关）
            if not self._static:
                self._popup_paint()
        except Exception:
            pass

    def _toggle_text_popup(self) -> None:
        """点「字」弹一条输入条。

        大窗小窗共用同一条：主体同宽的圆角矩形、左边对齐、贴在窗口下方
        （下面没地方就翻到上面）。**跟着窗口走**：拖窗、拉大拉小、换位置都会
        重新对齐；文字一行放不下就变宽，宽到上限就换行变高。
        """
        if self._text_popup is not None:
            self._close_text_popup()
            return
        try:
            top = tk.Toplevel(self.root)
        except Exception as exc:
            print("popup failed", repr(exc), flush=True)
            return
        try:
            top.overrideredirect(True)
            top.attributes("-topmost", True)
            top.configure(bg=KEY)
            if IS_WIN:
                top.attributes("-transparentcolor", KEY)
            c = tk.Canvas(top, width=300, height=self.POPUP_MIN_H,
                          bg=KEY, highlightthickness=0, bd=0)
            c.pack()
            fs = max(11, int(self._ui["fontSize"]))
            text = tk.Text(top, bg=self._style_colors()[2], fg="#eef6ff", insertbackground="#eef6ff",
                           relief="flat", bd=0, highlightthickness=0, wrap="word",
                           font=self.fonts.spec(fs), height=1, width=1, padx=0, pady=0)
            text.bind("<KeyRelease>", lambda _e: self._relayout_text_popup())
            text.bind("<Return>", self._on_popup_return)
            text.bind("<Escape>", lambda _e: self._close_text_popup())
            top.bind("<Escape>", lambda _e: self._close_text_popup())
            # 点到别的地方（包括别的程序）就收：弹条是"临时打字"的，不该赖着
            text.bind("<FocusOut>", self._on_popup_focus_out)
            self._text_popup, self._popup_canvas = top, c
            self._popup_text, self._popup_entry = text, text
            self._popup_w = self._popup_h = self.POPUP_MIN_H
            if getattr(self, "_no_activate_on", False):
                self._apply_no_activate(False)
            self._relayout_text_popup()
            text.focus_force()
            # 弹条开了 → 「字」按钮立刻切到"点击"态
            self._redraw_input_buttons()
        except Exception as exc:
            print("popup setup failed", repr(exc), flush=True)
            self._close_text_popup()

    def _on_popup_return(self, _event=None):
        """回车发送；Shift+回车留给换行。"""
        try:
            if _event is not None and (_event.state & 0x0001):
                return None
        except Exception:
            pass
        self._send_popup()
        return "break"

    def _close_text_popup(self) -> None:
        """收掉弹条。**收完要重画一次输入区**：那个「字」按钮的高亮看的是
        `_text_popup`，不重画就一直停在激活态（用户说的"动效卡了，不会变回默认"）。"""
        top, self._text_popup = getattr(self, "_text_popup", None), None
        self._popup_entry = None
        self._popup_text = None
        self._popup_canvas = None
        was = top is not None
        if top is not None:
            try:
                top.destroy()
            except Exception:
                pass
        if was:
            try:
                self._redraw_input_buttons()
                self.canvas.itemconfigure(self._bg, state="normal")
                self.text.refresh()
            except Exception:
                try:
                    self._layout()
                except Exception:
                    pass

    def _on_popup_focus_out(self, _event=None) -> None:
        """弹条失焦 → 稍等一下确认焦点真的跑到别处了再收（避免自己点自己就关）。"""
        def check():
            if self._text_popup is None:
                return
            try:
                w = self.root.focus_get()
            except Exception:
                w = None
            if w is self._popup_text:
                return
            # 焦点跑回主窗或跑出本程序（`None`）都算"点别处了" → 收
            self._close_text_popup()
        try:
            self.root.after(150, check)
        except Exception:
            pass

    def _send_popup(self) -> None:
        text = self._popup_text_value().strip()
        if not text:
            return
        try:
            append_user(text)
        except Exception as exc:
            print("popup send failed", repr(exc), flush=True)
            return
        try:
            if self._protocol is not None:
                self._protocol.action("say", text=text)
        except Exception:
            pass
        self._auto_at = time.time()
        self._close_text_popup()
        try:
            self.root.after(40, self._poll_chat)
        except Exception:
            pass

    def _mini_edge_tick(self) -> None:
        """**贴边半藏已移除**（用户要求）：小窗不再自己往屏幕外缩。"""
        return

    def _clip_text(self, text: str, size: int, width: int) -> str:
        """按像素宽度截断（单行）。`_fit_lines` 是折行，标题栏不能折 —— 折下去就压气泡了。"""
        text = str(text or "")
        font = self.fonts.get(size)
        if width <= 0 or font.measure(text) <= width:
            return text
        cur = ""
        for ch in text:
            if font.measure(cur + ch + "…") > width:
                break
            cur += ch
        return (cur + "…") if cur else ""

    def _bind_header(self) -> None:
        c = self.canvas
        c.tag_bind("close", "<Button-1>", self._close)
        c.tag_bind("danmaku", "<Button-1>", self.toggle_danmaku)
        # **不要**再给音符挂 Button-1：`_press` 里已经有一个圆形判定区，
        # 两个都触发 = 点一次切两下（= 没反应）。这正是"判定区没对齐"的真凶。
        # 音量条：停在「♪」上展开，移到条子上不收起（中间那点缝靠 250ms 缓冲抹掉）
        c.tag_bind("mute", "<Enter>", self._show_volume)
        c.tag_bind("mute", "<Leave>", self._schedule_hide_volume)
        c.tag_bind("volpop", "<Enter>", self._show_volume)
        c.tag_bind("volpop", "<Leave>", self._schedule_hide_volume)
        c.tag_bind("volpop", "<Button-1>", self._vol_press)
        c.tag_bind("volpop", "<B1-Motion>", self._vol_move)
        c.tag_bind("volpop", "<ButtonRelease-1>", self._vol_release)
        c.tag_bind("minimize", "<Button-1>",
                   lambda _e: self._apply_mode(MODE_MINI, save=True))
        # 三角的点击判定改成 `_press` 里按 `_hit_collapse` 判（贴着图案），
        # 不再用 tag_bind —— 那个框是整个文字 item 的 bbox，比图案大一圈。
        # 双击改名：单击要留给「按住标题拖动窗口」，两者不能抢同一个事件
        c.tag_bind("title", "<Double-Button-1>", self._edit_title)

    def _draw_feed(self) -> None:
        w = self._geo.width
        bubbles = self._bubbles()
        shown = bool(bubbles)
        if shown:
            shapes, infos = self._message_shapes(bubbles)
        else:
            shapes, infos = shapes_for(w, self._geo.height), []
        if shapes != self._geo.shapes:
            if self._resize:
                # 拖动中：只换槽位（overlay/box_maps 松手 `_rebuild` 再重建）
                try:
                    self._geo = replace(self._geo, shapes=tuple(shapes))
                except Exception:
                    pass
            else:
                with self._geo_lock:
                    self._set_geometry(self._geo.with_shapes(shapes, plate=bool(shown)))
        # 每条消息只按正文占一块；时间戳贴在气泡上方，不进框
        c = self.canvas
        for idx, info in enumerate(infos):
            if info["stamp"]:
                self.text.draw(info["tx"], info["stamp_y"], info["stamp"],
                               anchor=info["ta"], fill=info["stamp_fill"], size=9,
                               tags=("feed", "feedbody"))
            for li, line in enumerate(info["lines"]):
                # 气泡里有底板，文字颜色固定、再补一层 1px 深色偏移当描边
                self.text.draw(info["tx"], info["ty"] + li * info["ls"], line,
                               anchor=info["ta"], fill=info["fill"], size=info["size"],
                               tags=("feed", "feedbody"),
                               shadow=PLATE, adapt=not PLATE)
            bx0, by0, bx1, by1, _r = info["shape"]
            tag = f"bubble{idx}"
            # 整块气泡都是热区（点哪都能展开/收起）：原来只有被截断的才给入口，
            # 而「显示 150 字」之后几乎每条都可能被砍，入口得一直在。
            c.create_rectangle(bx0, by0, bx1, by1, fill="", outline="",
                               tags=("feed", "feedbody", "bubblehit", tag))
            # 右下角一个和正文等大的倒三角：提示"这里点得开"
            self.text.draw(bx1 - 12, by1 - info["ls"] // 2 - 2,
                           "▴" if info["expanded"] else "▾",
                           anchor="center", fill="#9fc7ff", size=info["size"],
                           tags=("feed", "feedbody", tag))
            c.tag_bind(tag, "<Button-1>",
                       lambda _e, k=info["key"]: self._toggle_expand(k))
        if not shown:
            # 没有消息：提示画在**消息区中间**。不能用 `shapes[0]` —— 空列表时
            # shapes 只剩末尾两个（输入栏 / 发送），那会把提示画进输入栏里。
            top = MSG_TOP
            bottom = max(top + 20, int(self._geo.height) - 80 - MSG_BOTTOM_MARGIN)
            self.text.draw(w // 2, (top + bottom) // 2,
                           "在这里跟它说话 · 滚轮翻历史", anchor="center",
                           fill="#8e9db2", size=12, tags=("feed", "feedbody"))

    # ---- 输入区：两个圆按钮 + 可展开的文本条 ----

    INPUT_BTN_R = 23        # 圆形按钮半径（用户：图标稍微放大一些）
    MIC_REC_COLOR = "#e8963c"    # 录音中：麦克风外圈橙色
    MIC_IDLE_COLOR = "#61708a"   # 静默：麦克风外圈灰蓝
    BTN3_GREEN = "#2ecc71"  # 标题栏第 3 个按钮：绿（默认）
    BTN3_RED = "#e0392b"    # 标题栏第 3 个按钮：红（点开），圆和矩形共用
    TEXT_OFFSET = 46        # 文字输入条相对「字」按钮再往右多少

    def _side_now(self) -> str:
        """按**当前**窗口位置算：靠屏幕右半边就 right，否则 left。

        刚拉起窗口的那一下 `winfo_x()` 还是 0（窗口还没摆好），于是会算成 left、
        两个圆画到左下角；鼠标一动 `_refresh_input_side()` 才发现该在右边 ——
        用户看到的就是"刚开窗位置不对，动一下鼠标又正常"。
        所以这里优先用 `self._x`（几何里记着的真实坐标），只在它和 winfo 都合理时用 winfo。
        """
        x = None
        try:
            x = int(self.root.winfo_x())
        except Exception:
            x = None
        if (x is None or x <= 0) and self._x is not None:
            x = int(self._x)
        if x is None:
            x = 0
        cx = x + self._geo.width / 2
        return "right" if cx >= self._vx + self._vw / 2 else "left"

    def _input_side(self) -> str:
        """两个圆按钮放左边还是右边（**画的时候定，命中判定也用它**）。

        用户要求：「文字和语音输入按钮根据浮窗所在的位置，位于左侧或右侧，避免阻挡屏幕」——
        按钮贴着**靠边那一侧**，屏幕中间那块内容就不会被它们压住。

        关键点：这个值必须**缓存**。以前每次调用都按实时窗口位置算，于是拖完窗口之后
        画面还停在旧的一侧、点击判定却已经跳到另一侧 —— 用户说的"判定不灵敏、
        有时候变有时候不变"就是这个。现在画的时候定一次，挪窗口后由
        `_refresh_input_side()` 主动刷新。
        """
        if self._side_cache is None:
            self._side_cache = self._side_now()
        return self._side_cache

    def _refresh_input_side(self) -> None:
        """窗口挪过之后重新判一次靠哪边；真的变了才重排。"""
        want = self._side_now()
        if want != self._side_cache:
            self._side_cache = want
            self._sync_button_band()      # 按钮换边了，玻璃带也得跟过去
            self._sync_button_band()      # 再对齐一次：几何重建后坐标可能又差一点
            try:
                self._layout()
            except Exception:
                pass

    def _sync_button_band(self) -> None:
        """把按钮玻璃重新对齐到按钮上（大窗底部那条 / 小窗两个圆那条）。

        建窗口时还不知道窗口会停在哪一侧，`_btns_box` 只能兜底 left；
        等窗口摆好（`_side_cache` 有了）必须重建一次几何，否则玻璃留在左侧、
        按钮跑到右侧 —— 看起来就是"按钮没有玻璃、纯透明"（用户实报）。
        小窗那条玻璃垫同理，而且**不能跳过**：它的初始几何是用大窗尺寸算的。
        """
        try:
            if getattr(self, "_band_syncing", False):
                return
            if self._mini:
                want = self._mini_btns_box()
                got = self._geo.slabs[-1] if len(self._geo.slabs) > 1 else None
            else:
                want = self._btns_box(self._geo.width, self._geo.height)
                got = self._geo.slabs[-1] if len(self._geo.slabs) > 2 else None
            if got and (abs(got[0] - want[0]) <= 2 and abs(got[2] - want[2]) <= 2
                        and abs(got[1] - want[1]) <= 2 and abs(got[3] - want[3]) <= 2):
                return
            self._band_syncing = True
            try:
                with self._geo_lock:
                    self._set_geometry(Geometry.for_size(
                        self._geo.width, self._geo.height,
                        version=self._geo.version + 1, mini=self._mini, btns=want))
                # 静态样式没有逐帧循环：几何换了必须立刻重画一张底板，
                # 否则垫片要等下一次 _layout 才跟过来（用户实报"动了才有"）
                if self._static:
                    try:
                        self._sync_static_frame()
                    except Exception:
                        pass
            finally:
                self._band_syncing = False
        except Exception:
            pass

    def _btns_box(self, w: int, h: int | None = None, side: str | None = None) -> tuple:
        """两颗输入圆合起来的 (最左, 最右)，给玻璃几何层收窄用。

        不依赖 `self._geo`：只按窗口宽度和贴边方向算，建几何之前就能调用。
        """
        h = int(h or (self._geo.height if getattr(self, "_geo", None) else 520))
        # 贴边方向：**优先用布局算好的 `_side_cache`**，别每次拿 `_x` 重猜 ——
        # 窗口还没摆好时 `_x` 是 0，会一直判成 left，玻璃就跑到没按钮的那一侧，
        # 于是两个按钮看起来"没有玻璃、纯透明"（用户实报）。
        side = side or getattr(self, "_side_cache", None)
        if not side:
            try:
                side = self._side_now()
            except Exception:
                # 建几何之前没有 `_geo`，`_side_now` 会抛 —— 先用左边兜底，布局后就会修正
                side = "left"
        o = 12
        x0, x1 = o, w - o
        r = self.INPUT_BTN_R
        gap = r * 2 + 8
        if side == "right":
            tx = x1 - 40
            mx = tx - gap
        else:
            mx = x0 + 40
            tx = mx + gap
        # 四条边一起给：玻璃要**套着圆**，不能只对 x 对齐（否则会偏下）
        # 圆心 y：优先用已建好的几何；但**小窗几何没有输入区**（input_shape 全零），
        # 那一刻用它会算出 y=27、垫片跑到窗口顶部（放大瞬间垫片"消失"就是它）。
        # 所以 mini 几何 / 退化值一律退回按高度算：(h - 输入条高) + 27，和 _input_points 一致。
        geo = getattr(self, "_geo", None)
        if (geo is not None and not getattr(geo, "mini", False)
                and geo.input_shape[1] > 0):
            cy = geo.input_shape[1] + 27
        else:
            cy = max(0, h - 80) + 27
        # 比两颗圆略大一圈（用户：玻璃做大点）
        pad = 6
        return (min(mx, tx) - r - pad, cy - r - pad, max(mx, tx) + r + pad, cy + r + pad)

    def _input_points(self) -> tuple:
        """两个圆的圆心：**(文字, 语音, 中线 y)**，按 `_input_side()` 靠左或靠右。

        用户指定的顺序：先一个写大写 `T` 的文字输入，再一个麦克风的语音输入。
        """
        x0, y0, x1, _y1, _r = self._geo.input_shape
        cy = y0 + 27
        gap = self.INPUT_BTN_R * 2 + 8        # 两个圆之间的空
        # **麦克风永远在 T 左边**（用户要求），两个圆作为一组整体靠左或靠右
        if self._input_side() == "right":
            tx = x1 - 40
            mx = tx - gap
        else:
            mx = x0 + 40
            tx = mx + gap
        return (tx, cy), (mx, cy), cy

    @staticmethod
    def _mic_into(d, cx: float, cy: float, scale: float, color: str) -> None:
        """把麦克风画进 PIL 的 canvas（4x 超采样后缩回去，所以边缘是圆的不是锯齿）。"""
        w = max(1.0, 1.8 * scale)
        d.rounded_rectangle((cx - 3.6 * scale, cy - 8.4 * scale,
                             cx + 3.6 * scale, cy + 2.0 * scale),
                            radius=3.6 * scale, fill=color)
        d.arc((cx - 9 * scale, cy - 5 * scale, cx + 9 * scale, cy + 9 * scale),
              start=20, end=160, fill=color, width=int(round(w)))
        d.line((cx, cy + 8.0 * scale, cx, cy + 12.4 * scale), fill=color,
               width=int(round(w)))
        d.line((cx - 5.2 * scale, cy + 12.4 * scale, cx + 5.2 * scale, cy + 12.4 * scale),
               fill=color, width=int(round(w)))

    def _glass_circle_photo(self, key: str, cx: float, cy: float):
        """把玻璃帧里圆所在的那一块裁出来（圆形遮罩 + 描边 + 麦克风图标）。

        两个坑（用户实报）：
        1. 圆按钮在窗口底部那条**透明图标条**里，那块帧本身就是键色 ——
           直接采样等于没有玻璃；所以取样点**往上挪到主体玻璃**里。
        2. 采样图只画了底和圈，**麦克风的图标丢了** —— 这里用 `_mic_into`
           把图标画进同一张图里。
        """
        frame = getattr(self, "_last_frame", None)
        if frame is None:
            return None
        r = int(self.INPUT_BTN_R)
        size = r * 2
        x0 = int(cx) - r
        y0 = int(cy) - r
        # 采样点往上挪：底部图标条是透明的，采样到的是键色（看起来"没玻璃"）
        try:
            body_bottom = self._geo.slabs[1][3]   # 主体下沿（最后一块是按钮窄玻璃）
        except Exception:
            body_bottom = int(self._geo.height) - 100
        if y0 + size > body_bottom:
            y0 = max(0, int(body_bottom) - size - 2)
        try:
            if x0 < 0 or y0 < 0 or x0 + size > frame.width or y0 + size > frame.height:
                return None
            crop = frame.crop((x0, y0, x0 + size, y0 + size)).convert("RGB")
            mask = Image.new("L", (size, size), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
            base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            base.paste(crop, (0, 0), mask)
            # 和底板区分开：压一层暗色（55%），否则圆和玻璃带同色 = 看着"透明了"
            shade = Image.new("RGBA", (size, size), (10, 16, 24, 140))
            base.alpha_composite(Image.composite(shade, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))
            _bf, _br, _pb, _pf = self._style_colors()
            d = ImageDraw.Draw(base)
            # 图标：麦克风（或 T 由调用方用画布文字补）
            if key == "mic":
                self._mic_into(d, size / 2.0, size / 2.0, r / 20.0 * 0.95,
                               self._icon_tone(cx, cy))
            d.ellipse((0, 0, size - 1, size - 1), outline=(*_br, 255), width=2)
            photo = ImageTk.PhotoImage(base, master=self.canvas)
            self._glass_btn_cache[(key, x0, y0)] = photo
            return photo
        except Exception:
            return None

    def _button_photo(self, key: str, r: int, tone: str, state: str = "idle"):
        """生成一颗**抗锯齿**的圆按钮（圆 + 可选麦克风），按 4 倍超采样再缩回来。

        三态（用户要求）：
        - `idle`   默认：暗环、深底；
        - `hover`  鼠标悬停：环和底都提亮一档（文字按钮专用）；
        - `active` 点击/按住：蓝色环 + 蓝底。

        Tk 8.6 的画布椭圆没有抗锯齿，直接 `create_oval` 一圈毛刺；所以整颗按钮
        用 PIL 画好当图片贴。结果按 (key, r, tone, state) 缓存。
        """
        cache = getattr(self, "_button_cache", None)
        if cache is None:
            cache = self._button_cache = {}
        state = state if state in ("idle", "hover", "active", "holding", "recording") else "idle"
        ck = (key, int(r), tone, state, str(getattr(self, "_glass_style", "") or "auto"))
        hit = cache.get(ck)
        if hit is not None:
            return hit
        ss = 8
        size = int(r) * 2 + 6
        img = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        cx = cy = size * ss / 2.0
        rr = int(r) * ss
        base_fill, base_ring, _pb, _pf = self._style_colors()
        if state == "recording":
            # 点一下开始录音：**橙色**底，一直亮着，直到再点一次
            ring, fill = (232, 150, 60, 255), (120, 68, 16, 255)
        elif state in ("active", "holding"):
            # 按住说话：**蓝**底
            ring, fill = (74, 163, 255, 255), (23, 50, 77, 255)
        elif state == "hover":
            ring, fill = (104, 140, 178, 255), (26, 38, 55, 255)
        else:
            ring = (*base_ring, 255)
            fill = (*base_fill, 255)
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=ring)
        inner = rr - int(round(1.4 * ss))
        d.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=fill)
        if key == "mic":
            self._mic_into(d, cx, cy, rr / 20.0, tone)
        img = img.resize((size, size), Image.Resampling.LANCZOS)
        # **alpha 二值化**：窗口是靠 `-transparentcolor` 抠色的，半透明的边缘像素会和
        # 键色混成一圈近黑的噪点 —— 用户看到的"毛躁"就是它。把边缘拍平成 0/255，
        # 只剩一圈实色描边，干净得多。
        try:
            img.putalpha(img.getchannel("A").point(lambda a: 255 if a >= 128 else 0))
        except Exception:
            pass
        photo = ImageTk.PhotoImage(img, master=self.canvas)
        cache[ck] = photo
        return photo

    def _input_circle(self, key: str, cx: float, cy: float, glyph: str,
                      tone: str, *, active: bool = False, hover: bool = False,
                      state=None) -> None:
        """一个圆按钮。`text` 画大写 T，`mic` 画麦克风（用户指定的图标）。

        圆和麦克风都是一张抗锯齿图片（见 `_button_photo`），只有 T 用 Canvas 文字 ——
        Tk 的文字渲染本身是带抗锯齿的。
        """
        c = self.canvas
        tags = ("inputbtn", f"in-{key}")
        if state is None:
            state = "active" if active else ("hover" if hover else "idle")
        # **不要圆底**（用户要求：圆跟背景一起消失，只留图标和 T）。
        # 所以这里不画填充/描边，只画图标本身：
        if key == "mic":
            r = int(self.INPUT_BTN_R)
            size = r * 2
            glyph_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            d = ImageDraw.Draw(glyph_img)
            self._mic_into(d, size / 2.0, size / 2.0 - 2.5, r / 20.0 * 1.15,
                           self._icon_tone(cx, cy))
            photo = ImageTk.PhotoImage(glyph_img, master=c)
            self._bare_icons[key] = photo
            # **状态环**：画在图标和小框之间，用它的颜色表示录音/静默，
            # 图标本身继续跟着背景明暗变（用户要求两者都要）。
            ring_r = int(self.INPUT_BTN_R) + 1   # 比图标整体大一圈（用户要求）
            rec = (state == "recording")
            ring_col = self.MIC_REC_COLOR if rec else self.MIC_IDLE_COLOR
            # **圆环也用 4x 超采样的图片**：canvas 的 oval 没有抗锯齿，看起来毛糙
            try:
                ss = 4
                dn = (ring_r + 2) * 2 * ss
                ring_img = Image.new("RGBA", (dn, dn), (0, 0, 0, 0))
                rd = ImageDraw.Draw(ring_img)
                wpx = 4 * ss
                rd.ellipse((wpx / 2, wpx / 2, dn - wpx / 2, dn - wpx / 2),
                           outline=ring_col, width=wpx)
                ring_img = ring_img.resize((dn // ss, dn // ss), Image.LANCZOS)
                ring_photo = ImageTk.PhotoImage(ring_img, master=c)
                self._bare_icons[f"ring{key}"] = ring_photo
                c.create_image(cx, cy, image=ring_photo, tags=(tags[0], "micring"))
            except Exception:
                c.create_oval(cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r,
                              outline=ring_col, width=4, tags=(tags[0], "micring"))
            self._mic_item = c.create_image(cx, cy, image=photo, tags=tags)
            self._mic_center = (cx, cy)
            self._mic_ring_state = rec
        else:
            self.text.draw(cx, cy, glyph, anchor="center", fill=self._icon_tone(cx, cy),
                           size=max(16, int(self.INPUT_BTN_R * 0.95)),
                           bold=True, tags=tags)

    def _draw_input(self) -> None:
        """输入栏：只有两个圆形按钮（语音 / 文字）。

        **mini 下直接返回**：小窗有自己的两个圆（`_draw_mini` 画的），
        大窗这套会 `delete("inputbtn")` 把它们删掉 —— 那就是用户说的
        "两个输入按钮有时候突然消失"。
        """
        if self._mini:
            return
        """输入栏：只有两个圆形按钮（语音 / 文字）。

        用户要求：「大小窗口都只有文字输入开关，不直接显示输入条，点击之后弹出输入条」——
        所以这里不再常驻输入框、不再画「点『字』打字」、也不在右边留「发送」；
        打字一律走 `_toggle_text_popup()` 弹出来的那条。
        """
        self._ensure_entry()
        self.canvas.delete("inputbtn")      # 重画前先清旧的（悬停/按住时会重进这里）
        mic_on = self._mic_proc is not None and self._mic_proc.poll() is None
        (tcx, _), (mcx, _), cy = self._input_points()
        self._input_circle("text", tcx, cy, "T", "#eaf4ff",
                           active=getattr(self, "_text_popup", None) is not None,
                           hover=getattr(self, "_hover_text", False))
        holding = bool(getattr(self, "_mic_hold", False))
        # **只有两种状态**：正在收音（按住说话也算）＝橙；静默＝默认不动
        mic_state = "recording" if (mic_on or holding) else "idle"
        self._input_circle("mic", mcx, cy, "T",
                           "#ffb4b4" if (mic_on or holding) else "#cfe0f5",
                           active=mic_state != "idle", state=mic_state)
        self._hit_mic = (mcx, cy, self.INPUT_BTN_R)
        self._hit_text = (tcx, cy, self.INPUT_BTN_R)

    def _redraw_input_buttons(self) -> None:
        """只重画输入区那两个圆（悬停、按住时会频繁调）。"""
        try:
            if self._mini:
                # mini 下**整窗重排**：局部删很容易漏掉上一档的 item，
                # 切换档位后画布上就会留着大窗/折叠条的一整套残影
                self._layout()
                return
            self.canvas.delete("inputbtn")
            self._draw_input()
            self.text.refresh()
        except Exception:
            pass


    # ---- 实时转写预览：说话时弹一条"输入框"，字跟着出来 ----

    def _poll_live_text(self) -> None:
        """读 mic-partial.json：有内容就把预览框展开，空了/过期就收起。"""
        try:
            raw = json.loads(MIC_PARTIAL.read_text(encoding="utf-8"))
        except Exception:
            self._hide_live_text()
            return
        try:
            fresh = time.time() * 1000 - float(raw.get("at") or 0) < 1600
        except Exception:
            fresh = False
        text = str(raw.get("text") or "").strip()
        if fresh and text:
            self._show_live_text(text)
        else:
            self._hide_live_text()

    def _show_live_text(self, text: str) -> None:
        """在输入按钮上方弹一条只读预览（跟"字"那条弹框同款、不抢焦点）。

        为什么不复用 `_toggle_text_popup()`：那条要 `focus_force()`、FocusOut 就关，
        说话时一打字/一点别处就没了；预览是纯展示，不能跟用户的输入抢。
        """
        if text == self._live_text and self._live_box is not None:
            try:
                if self._live_box.state() == "normal":
                    return                          # 同一句、框还开着：别重画，会闪
            except Exception:
                return
        self._live_text = text
        try:
            fs = max(11, int(self._ui["fontSize"]))
            top = self._live_box
            if top is None:
                top = tk.Toplevel(self.root)
                top.overrideredirect(True)
                top.attributes("-topmost", True)
                top.configure(bg=KEY)
                if IS_WIN:
                    top.attributes("-transparentcolor", KEY)
                c = tk.Canvas(top, width=320, height=44, bg=KEY,
                              highlightthickness=0, bd=0)
                c.pack()
                self._live_box, self._live_canvas = top, c
            c = self._live_canvas
            pad = 10
            font = self.fonts.spec(fs)
            # 先量一次：按文字实际大小定框（比固定宽度自然，短句不会拖一条长条）
            tid = c.create_text(pad, pad, text=text, width=300, anchor="nw",
                                fill="#eef6ff", font=font)
            x1, y1, x2, y2 = c.bbox(tid)
            w = max(180, min(320, x2 + pad))
            h = max(36, y2 + pad)
            c.delete(tid)
            c.configure(width=w, height=h)
            c.delete("all")
            c.create_rectangle(0, 0, w, h, fill=self._style_colors()[2], outline="")
            c.create_text(pad, pad, text=text, width=w - 2 * pad, anchor="nw",
                          fill="#eef6ff", font=font)
            (_tx, _ty), _mc, cy = self._input_points()
            rx, ry = self.root.winfo_rootx(), self.root.winfo_rooty()
            top.geometry(f"{w}x{h}+{rx + int(_tx) - 6}+{ry + int(cy) - h - 12}")
            top.deiconify()
            top.lift()
        except Exception:
            pass

    def _hide_live_text(self) -> None:
        if getattr(self, "_live_text", ""):
            self._live_text = ""
        top = getattr(self, "_live_box", None)
        if top is not None:
            try:
                top.withdraw()
            except Exception:
                pass

    def _enter_text_btn(self, _e=None) -> None:
        if getattr(self, "_hover_text", False):
            return
        self._hover_text = True
        self._redraw_input_buttons()

    def _leave_text_btn(self, _e=None) -> None:
        if not getattr(self, "_hover_text", False):
            return
        self._hover_text = False
        self._redraw_input_buttons()

    def _mic_press(self, _e=None) -> None:
        """按住麦克风：立刻进入激活态（用户：长按要保持激活）。

        松手时再决定是"短按开关"还是"长按说完就停"，见 `_mic_hold_end()`。
        """
        self._mic_down_at = time.time()
        self._mic_was_on = self._mic_proc is not None and self._mic_proc.poll() is None
        self._mic_hold = True
        if not self._mic_was_on:
            self._toggle_mic()          # 开始录
        self._redraw_input_buttons()

    def _mic_hold_end(self) -> None:
        """松手：短按 = 开关；长按（>=350ms）= 按住说话，松手就停。"""
        if not getattr(self, "_mic_hold", False):
            return
        self._mic_hold = False
        held = time.time() - float(getattr(self, "_mic_down_at", 0) or 0)
        on = self._mic_proc is not None and self._mic_proc.poll() is None
        if held >= 0.35:
            if on:
                self._toggle_mic()
        elif self._mic_was_on and on:
            self._toggle_mic()          # 本来就开着、短按一下 → 关掉
        self._redraw_input_buttons()

    def _scrollbar_geom(self):
        """滚动条的位置：(x, y0, y1)。没有溢出就返回 None。

        用户要求：放到历史信息框**内部**，别贴在外面那条透明边上。
        """
        try:
            body = self._geo.slabs[1]   # 主体（最后一块现在是按钮窄玻璃）
        except Exception:
            return None
        total = len(self.feed.messages)
        visible = self._slot_estimate()
        if total <= visible:
            return None
        # 主体右内沿再往里 16px：右边 20px 那条留给"拖边缘缩放"，
        # 两者不能重叠（用户说现在重合了，一抓就把窗口拉宽）
        x = self._geo.width - SLAB_OUT - 16
        top = body[1] + 8
        view_h = max(1, body[3] - body[1] - 16)
        thumb = max(24, int(view_h * (visible / float(total))))
        max_off = max(1, total - visible)
        t = 1.0 - max(0, min(max_off, self.feed.offset)) / float(max_off)
        y0 = top + t * max(0, view_h - thumb)
        return (x, y0, y0 + thumb)

    def _draw_scrollbar(self) -> None:
        """滚动条：位置在 `_scrollbar_geom()`，这里只管建/更新那一根线。"""
        c = self.canvas
        g = self._scrollbar_geom()
        if g is None:
            if self._sbar is not None:
                try:
                    c.delete(self._sbar)
                except Exception:
                    pass
                self._sbar = None
            return
        alive = False
        if self._sbar is not None:
            try:
                alive = c.type(self._sbar) == "line"
            except Exception:
                alive = False
        if not alive:
            self._sbar = None
            self._sbar = c.create_line(g[0], g[1], g[0], g[2], width=3,
                                       fill="#8d95a4", capstyle="round", tags=("sbar",))
        else:
            c.coords(self._sbar, g[0], g[1], g[0], g[2])
            c.itemconfigure(self._sbar, state="normal")
        c.tag_raise("sbar")

    def _refresh_feed(self) -> None:
        """聊天流变了就重排；Entry 的草稿和焦点要保住（它在 _layout 里复用）。"""
        if not hasattr(self, "canvas"):
            return
        self._layout()
        if self._last_frame is not None:
            self._adapt_now(self._last_frame)

    def _adapt_now(self, frame) -> None:
        self._aux_at = 0.0
        self.text.adapt(frame)
        self._adapt_bar(frame)

    def _adapt_bar(self, frame) -> None:
        """最上面细条随背景切换深浅（同样要滞回，理由见 TextLayer.adapt）。"""
        if frame is None or self._bar is None:
            return
        now = time.time()
        if now - self._aux_at < 0.25:
            return
        self._aux_at = now
        mid = self._geo.width // 2
        half = max(50, self._bar_len // 2)
        try:
            arr = np.asarray(frame.convert("L"))
        except Exception:
            return
        patch = arr[max(0, BAR_Y - 6):BAR_Y + 12, max(0, mid - half):mid + half]
        if patch.size == 0:
            return
        p50 = float(np.median(patch)) / 255.0
        cur = self._bar_color
        if cur == "#4e6278":
            fill = "#b8cbe0" if p50 < 0.36 else cur      # 已很深：要够暗才翻浅
        else:
            fill = "#4e6278" if p50 > 0.60 else cur
        if fill != cur:
            self._bar_color = fill
            try:
                self.canvas.itemconfigure(self._bar, fill=fill)
            except Exception:
                pass

    # ---- 预览 / 重建 ----

    # ---- 缩放时的"九宫格"：只让消息区变形 ----

    def _nine_slice(self, frame, w: int, h: int):
        """把上一帧按"标题栏 / 消息区 / 输入栏"三段拼成新尺寸。

        用户要求：「拉伸时只有中间消息展示区变形，其他部分只变换位置，不变尺寸」——
        所以顶部标题栏和底部输入栏**只在水平方向缩放**（高度不变），
        只有中间那段跟着纵向拉伸。直接 `resize((w,h))` 会把标题栏和输入栏
        一起压扁/拉长，看起来整窗都在变形。
        """
        if frame is None:
            return None
        try:
            old_w, old_h = frame.size
            top_h, bot_h = SLAB_TOP_H, SLAB_BOT_H
            if old_h <= top_h + bot_h + 8 or h <= top_h + bot_h + 8:
                return frame.resize((max(1, w), max(1, h)), Image.Resampling.BILINEAR)
            out = Image.new("RGB", (max(1, w), max(1, h)), KEY)
            # 顶条：横向缩放，纵向保持原高（位置也不变）
            if w != old_w or top_h != top_h:
                top = frame.crop((0, 0, old_w, top_h)).resize((max(1, w), top_h),
                                                              Image.Resampling.BILINEAR)
            else:
                top = frame.crop((0, 0, old_w, top_h))
            out.paste(top, (0, 0))
            # 底条：横向缩放 + 高度不变，位置贴到新的底
            bot = frame.crop((0, old_h - bot_h, old_w, old_h)).resize(
                (max(1, w), bot_h), Image.Resampling.BILINEAR)
            out.paste(bot, (0, max(0, h - bot_h)))
            # 中间：整块缩放
            mid_h = max(1, h - top_h - bot_h)
            mid = frame.crop((0, top_h, old_w, old_h - bot_h)).resize(
                (max(1, w), mid_h), Image.Resampling.BILINEAR)
            out.paste(mid, (0, top_h))
            return out
        except Exception:
            try:
                return frame.resize((max(1, w), max(1, h)), Image.Resampling.BILINEAR)
            except Exception:
                return None

    def _quick_bars(self, w: int, h: int) -> None:
        """拖动时**每帧**更新顶部线和滚动条（只改坐标，不重建 item）。

        用户说"图标、滚动条、顶部线刷新率低、拖动有闪烁" —— 这三样以前挤在 80ms
        那次重排里，骨架却在每帧动，节奏不一致就看着闪。现在它们跟着每一帧走。
        """
        c = self.canvas
        if self._bar is not None:
            L = max(72, int(w * BAR_FRAC))
            self._bar_len = L
            try:
                c.coords(self._bar, w // 2 - L // 2, BAR_Y, w // 2 + L // 2, BAR_Y)
            except Exception:
                pass
        g = self._scrollbar_geom()
        if g is None:
            if self._sbar is not None:
                try:
                    c.itemconfigure(self._sbar, state="hidden")
                except Exception:
                    pass
            return
        alive = False
        if self._sbar is not None:
            try:
                alive = c.type(self._sbar) == "line"
            except Exception:
                alive = False
        if not alive:
            self._sbar = c.create_line(g[0], g[1], g[0], g[2], width=3,
                                       fill="#8d95a4", capstyle="round", tags=("sbar",))
        else:
            c.coords(self._sbar, g[0], g[1], g[0], g[2])
            c.itemconfigure(self._sbar, state="normal")
        try:
            c.tag_raise("sbar")
        except Exception:
            pass

    def _quick_frame(self, w: int, h: int) -> None:
        """拖动缩放的过渡画面：**画骨架，不拉伸上一帧**。

        用户说「拉动的时候还是有变形，松开鼠标才正常」—— 变形来自把上一帧玻璃位图
        拉成新尺寸（那本来就是一张桌面照片，一拉就花）。现在拖动期间干脆不贴照片：
        按新尺寸画两块实色圆角（标题栏 / 主体），圆按钮按新位置摆好，
        松手的 `_rebuild()` 再把真的玻璃贴回来。
        """
        c = self.canvas
        # 照片和消息文字先藏起来（不删，省得闪）
        if self._bg is not None:
            try:
                c.itemconfigure(self._bg, state="hidden")
            except Exception:
                pass
        self._quick_bars(w, h)
        c.delete("quickskel")
        try:
            from glass_geometry import slabs_for as _slabs
            slabs = _slabs(int(w), int(h))
        except Exception:
            slabs = ()
        for box in slabs[:2]:
            x0, y0, x1, y1 = box[0], box[1], box[2], box[3]   # 玻璃板是 4 元组
            if x1 > x0 and y1 > y0:
                self._round_rect(c, x0, y0, x1, y1, SLAB_RADIUS, "#0b1220",
                                 tags=("quickskel",))
        c.tag_lower("quickskel")
        # **文字实时更新**：拖动中按 ~12fps 重排一次消息（用户要求实时跟随）。
        # 每帧都排要 24ms+，60fps 跟不上；80ms 一次肉眼基本是"跟着走"，
        # 而骨架和两个圆是每帧都动，所以窗口形状一直是跟手的。
        now = time.time()
        if now - float(getattr(self, "_quick_text_at", 0.0) or 0.0) >= 0.08:
            self._quick_text_at = now
            try:
                c.delete("feedbody")
                c.delete("hdr")           # 标题栏整批删（不然每 80ms 叠一层残影）
                self.text.reset()
                self._draw_header()
                self._draw_feed()
                self._draw_input()
                self.text.refresh()
            except Exception as exc:
                print("quick text failed", repr(exc), flush=True)
        # 圆按钮跟着窗口底边走（位移，不重画）
        try:
            _t, _m, cy = self._input_points()
            prev = getattr(self, "_quick_cy", None)
            if prev is not None:
                dy = int(round(cy - prev))
                if dy:
                    c.move("inputbtn", 0, dy)
            self._quick_cy = cy
        except Exception:
            pass
        try:
            c.tag_raise("inputbtn")
        except Exception:
            pass

    def _light_geometry(self, w: int, h: int) -> "Geometry":
        """只换尺寸/槽位的轻量几何：**不重建遮罩、折射图、overlay**。

        这三个东西（4 倍超采样的圆角遮罩、warp 网格、气泡底板）是 `for_size()`
        里最贵的部分，拖动时每帧重建一遍必然卡顿、画面还会闪。拖动期间它们根本
        用不上（渲染线程是停的），松手的 `_rebuild()` 才真正重建。
        """
        base = self._geo
        try:
            slabs = slots = None
            from glass_geometry import slabs_for as _slabs, shapes_for as _shapes
            slabs, slots = _slabs(w, h), _shapes(w, h)
            return replace(base, width=w, height=h, slabs=slabs, shapes=slots,
                           mask_hard=None, warp_x=None, warp_y=None,
                           overlay=None, overlay_half=None,
                           box_maps=(), box_union_half=None,
                           version=base.version + 1)
        except Exception:
            return base

    def _preview_resize(self, w: int, h: int) -> None:
        """拖拽时：轻几何 + 只重排固定件，松手后再完整重建。

        以前这里每帧都 `Geometry.for_size()`（遮罩 + warp + overlay 全重建）再
        `_layout()`（连消息逐字重画）—— 横向纵向都拖一下就是又闪又卡。
        """
        if w < MIN_W or h < MIN_H:
            return
        with self._geo_lock:
            self._geo = self._light_geometry(w, h)
        self.canvas.config(width=w, height=h)
        if self._last_frame is not None and self._last_frame.size != (w, h):
            # 只让消息区纵向变形：标题栏/输入栏保持原高（见 `_nine_slice`）
            sliced = self._nine_slice(self._last_frame, w, h)
            if sliced is not None:
                self._last_frame = sliced
        self._layout(quick=True)

    def _reset_quick(self) -> None:
        """退出拖动：下一次完整重排前把"过渡帧"的基准清掉。"""
        self._quick_cy = None
        self._quick_text_at = 0.0

    def _rebuild(self, w: int, h: int) -> None:
        """松手后按最终尺寸重建（含遮罩/折射图）。"""
        self._pause.set()
        with self._geo_lock:
            self._set_geometry(Geometry.for_size(w, h, btns=self._btns_box(w, h)))
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
        self._layout(seed=True)
        self._pause.clear()

    # ---- 截屏 / 心跳 ----

    def _snapshot_mode(self) -> None:
        """只给文档截图：停抓取、关 WDA，保留最后一帧（不改变正常路径）。"""
        self._snapshot_done = True
        self._pause.set()
        if self._excluded:
            self._set_exclude(False)

    def _beat(self) -> None:
        """写心跳（每秒最多一次）。

        以前写的是**空文件**，插件侧只能看 mtime —— 那只能回答"进程还在画吗"，
        回答不了"用户能不能看见"。于是出现最难受的一种状态：配置文件写
        `hidden:false`、进程活着、心跳在跳，屏幕上一片空，`status` 却说"显示中"
        （see-now issue #32 第 3 点）。

        现在把**窗口的真实可见性**一起写进去。mtime 仍然可用，老版本读法不受影响；
        内容是多出来的一份事实。

        必须原子写：插件每秒都可能读它，读到半行 JSON 会被当成"没有可见性"，
        于是退回读配置文件 —— 那正好是这一版要修的东西。
        """
        now = time.time()
        if now - getattr(self, "_beat_at", 0.0) < HEARTBEAT_EVERY:
            return
        self._beat_at = now
        try:
            HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
            tmp = HEARTBEAT.with_name("window-heartbeat.tmp")
            tmp.write_bytes(self._beat_payload(now))
            os.replace(tmp, HEARTBEAT)
        except Exception:
            pass

    def _beat_payload(self, now: float) -> bytes:
        """心跳内容：`{at, visible, hidden, state}`。

        `hidden` 是**意图**（配置文件要求藏），`visible` 是**事实**（Tk 说了算）。
        两个都要写 —— 只写事实的话，插件分不清"用户故意藏的"和"想显示但没 map 出来"。
        """
        try:
            state = str(self.root.state())
        except Exception:
            state = "unknown"
        visible = (not self._hidden) and state == "normal"
        try:
            visible = visible and bool(self.root.winfo_ismapped())
        except Exception:
            visible = False
        return json.dumps(
            {"at": round(now, 3), "visible": visible, "hidden": bool(self._hidden), "state": state},
            ensure_ascii=False,
        ).encode("utf-8")

    # ---- 主循环 ----

    def _tick(self) -> None:
        self._beat()
        if self._static:
            # 静态底板：没有帧要取、没有渐变要算。只留心跳（插件靠它判断窗口还活着）
            # 和低频定时器，CPU 占用基本为 0。
            self.root.after(500, self._tick)
            return
        if SNAPSHOT and self._snapshot_done:
            self._pause.set()
            if self._excluded:
                self._set_exclude(False)
            self.root.after(100, self._tick)
            return
        if PREVIEW:
            self._pause.set()
            if self._excluded:
                self._set_exclude(False)
            self.root.after(100, self._tick)
            return
        # 缩放拖拽期间由 _preview_resize 负责画面，避免旧帧覆盖预览
        if self._resize or self._collapsed:
            self.root.after(INTERVAL_MS, self._tick)
            return
        if not self._excluded and not self._cappable and not self._solid:
            self._set_exclude(True)
        self._pause.clear()

        try:
            out = self._q.get_nowait()
        except queue.Empty:
            out = None
        delay = INTERVAL_MS
        # **自适应帧率**：画面连续没变化就把采集间隔拉长（省 CPU/GPU），
        # 一变回来立刻恢复原帧率。判断用很轻的抽样哈希，不做整帧比较。
        if out is not None:
            try:
                sig = hash(out.tobytes()[::997])
            except Exception:
                sig = None
            if sig is not None and sig == getattr(self, "_frame_sig", None):
                self._still = int(getattr(self, "_still", 0)) + 1
            else:
                self._still = 0
            if sig is not None:
                self._frame_sig = sig
            self._frame_changed = (int(getattr(self, "_still", 0)) == 0)
            if int(getattr(self, "_still", 0)) >= 6:
                delay = max(INTERVAL_MS, 120)      # 静止 ~0.2s 后降到 ~8fps
        if out is not None:
            t_draw = time.perf_counter()
            try:
                self._last_frame = self._coerce_frame(out)
                self._img = ImageTk.PhotoImage(self._last_frame, master=self.canvas)
                self.canvas.itemconfigure(self._bg, image=self._img)
                self.canvas.tag_lower(self._bg)
                if getattr(self, "_frame_changed", True):
                    # 帧没变时这些适配的结果也一定没变，跳过（静态画面省一大截）
                    self.text.adapt(out)
                    self._adapt_bar(out)
                    self._adapt_bubble_icon()
                    self._adapt_input_buttons()
            except Exception as exc:
                print("draw error", exc, flush=True)
            cost_ms = (time.perf_counter() - t_draw) * 1000.0
            self._draw_ms = self._draw_ms * 0.8 + cost_ms * 0.2
            # 主线程绘制本身超过一帧预算时，别按固定 16ms 硬塞下一帧：
            # 给 Tk 留出处理鼠标/键盘的时间，否则事件队列越积越长，手感就是卡。
            delay = max(INTERVAL_MS, min(100, int(self._draw_ms * 1.5)))

        self.root.after(delay, self._tick)

    def _work(self, stop: threading.Event) -> None:
        """抓取 + 合成全在后台，主线程只负责显示最新一帧。

        `stop` 是**这一次线程**的开关（不是 `self._stop`）：换样式时会停一次、
        再换 live 时又要起一次，共用一个 Event 的话第二次一启动就退出。
        """
        import mss

        idle = 0
        with mss.mss() as sct:
            while not stop.is_set() and not self._stop.is_set():
                if self._pause.is_set() or self._collapsed:
                    time.sleep(0.03)
                    continue
                t0 = time.perf_counter()
                try:
                    out = self._renderer.render(self._source, sct, self._bbox())
                    if out is not None:
                        idle = 0
                        try:
                            self._q.get_nowait()
                        except queue.Empty:
                            pass
                        self._q.put(out)
                    else:
                        idle += 1
                except Exception as exc:
                    print("capture error", exc, flush=True)
                    # GPU 起不来（没有 moderngl / 显卡不支持 GL3.3）就换回 CPU，
                    # 不然后台线程每帧刷一条，用户只看到一块永远不刷新的玻璃。
                    if getattr(self._renderer, "broken", False):
                        print("GPU 不可用，切换到 CPU 渲染", flush=True)
                        self._renderer = CpuRenderer(self._geo)
                dt = time.perf_counter() - t0
                self._ema = self._ema * 0.9 + dt * 0.1
                if self._ema > 0.026:
                    target = 45
                elif self._ema > 0.016:
                    target = 60
                elif self._ema > 0.011:
                    target = 90
                else:
                    target = MAX_FPS
                # 自适应只能往下走；不能越过启动时的上限（默认 60），
                # 否则 120fps 的旧阈值会把已经设成 60 的窗口又抬回 90fps。
                self._target_fps = max(30, min(target, MAX_FPS, self._hz))
                # 静态画面：合成已经跳过，但「有没有变」只能靠抓屏看，单次 grab
                # 就要 ~7ms —— 按 60fps 空转等于白烧 40% 单核。探针降到 30fps，
                # 有变化时 idle 立刻归零、下一拍就恢复全速（最坏多等 33ms，
                # 拖动/滚动/播视频这类真的在动的情况根本进不到这个分支）。
                fps = self._target_fps if idle <= 20 else min(self._target_fps, PROBE_FPS)
                time.sleep(max(0.004, 1 / max(1, fps) - dt))

    # ---- 窗口句柄 ----

    def _hwnd_root(self):
        if not IS_WIN:
            return None
        if self._hwnd is None:
            self._hwnd = ctypes.windll.user32.GetAncestor(self.root.winfo_id(), 2)
        return self._hwnd

    def _apply_no_activate(self, on: bool) -> None:
        """给窗口加 / 摘 `WS_EX_NOACTIVATE`（Windows only，见 `no_activate_wanted`）。

        加上之后点窗不激活它，Windows 也就不重排 topmost 带 —— 全屏游戏里点悬浮窗
        不会把宿主窗顶到前面（#44 第 1 条）。代价是**键盘焦点也拿不到**，所以点输入框
        时要先摘掉（`_focus_input`），而且摘掉之后本次运行不再加回：用户既然要点输入框，
        就是准备打字了，再抢走焦点只会更烦人。
        """
        if not IS_WIN:
            return
        try:
            hwnd = self._hwnd_root()
            u = ctypes.windll.user32
            ex = int(u.GetWindowLongW(hwnd, GWL_EXSTYLE))
            want = (ex | WS_EX_NOACTIVATE) if on else (ex & (~WS_EX_NOACTIVATE & 0xFFFFFFFF))
            if want != ex:
                u.SetWindowLongW(hwnd, GWL_EXSTYLE, want)
            self._no_activate_on = bool(on)
        except Exception as exc:
            self._no_activate_on = False
            print("noActivate 设置失败", repr(exc), flush=True)

    def _set_exclude(self, on: bool) -> None:
        """WDA：让窗口从屏幕捕获里消失，抓自己所在区域时抓到的是背后的桌面。

        macOS/Linux 没有这个 API，**不能抓、也不能设**：硬调就是 AttributeError。
        返回 False 之后 `_cappable` 会被打开，改走"抓到了就把自己那块填掉"那条路
        （见 `glass_capture.fill_own_rect`），否则会递归地拍到自己。
        """
        if not IS_WIN:
            self._excluded = False
            return
        hwnd = self._hwnd_root()
        fn = ctypes.windll.user32.SetWindowDisplayAffinity
        fn.argtypes = [wintypes.HWND, wintypes.DWORD]
        fn.restype = wintypes.BOOL
        ok = bool(fn(hwnd, 0x11 if on else 0))
        self._excluded = ok and on
        if not ok:
            print("WDA failed", ctypes.GetLastError(), flush=True)

    def _bbox(self):
        if not IS_WIN:
            # 非 Windows 没有 GetWindowRect；用 Tk 自己的屏幕坐标顶上。
            # Retina 上是逻辑像素，和 mss 的物理像素可能差一个缩放倍数 ——
            # 已知的遗留问题，那类机器上建议用 frost/solid（都不抓屏）。
            try:
                x, y = int(self.root.winfo_rootx()), int(self.root.winfo_rooty())
                return (x, y, x + int(self.root.winfo_width()), y + int(self.root.winfo_height()))
            except Exception:
                return (0, 0, 0, 0)
        rc = _RECT()
        ctypes.windll.user32.GetWindowRect(self._hwnd_root(), ctypes.byref(rc))
        return (rc.left, rc.top, rc.right, rc.bottom)

    def _sync_pos(self) -> None:
        """把 Tk 当前左上角同步回 _x/_y。

        拖动/缩放只改了 root.geometry，没改这两个缓存；折叠时如果继续用旧坐标，
        窗口会被拉回拖动前的位置（用户看到的就是「点收起位置跳回」）。
        """
        try:
            self._x = int(self.root.winfo_x())
            self._y = int(self.root.winfo_y())
        except Exception:
            pass

    def _save_geometry(self, x=None, y=None) -> None:
        """记住完整态的位置。折叠只是临时压高度，不能把 78 当成窗口尺寸存下去。

        尺寸取 `_geo` 而**不能取 `winfo_height()`**：`root.geometry()` 是异步的，
        刚设完读回来还是上一档的值（实测折叠时存成 560、展开时存成 78，正好互换）。

        坐标同理：`_enter_mini` / `_exit_mini` 刚调过 `geometry()`，此刻 `winfo`
        还是旧值 —— 传了 `x/y` 就**不要**再 `_sync_pos()`，否则刚算好的贴边位置
        会被旧坐标覆盖，"小窗没贴到边上"（实测）。
        """
        if x is None or y is None:
            self._sync_pos()
            x, y = self._x, self._y
        else:
            self._x, self._y = int(x), int(y)
        if self._collapsed or self._mini:
            w, h = self._saved_w, self._saved_h
        else:
            w, h = self._geo.width, self._geo.height
        write_config({"geometry": f"{int(w)}x{int(h)}+{int(x)}+{int(y)}"})

    # ---- 关闭 / 隐藏 ----

    def _close(self, _e=None):
        try:
            self._hide_native_tip()
            if getattr(self, "_tip_win", None) is not None:
                self._tip_win.destroy()
                self._tip_win = None
        except Exception:
            pass
        try:
            self._save_geometry()
            self._close_bubble_win()
            self._stop_mic()
            # 弹幕层和托盘都是本进程的额外窗口：不显式关的话，`root.destroy()`
            # 也会带走它们，但那些 after job 会先报一次 "invalid command name"。
            if self._danmaku is not None:
                self._danmaku.close()
                self._danmaku = None
            if self._tray is not None:
                self._tray.close()
                self._tray = None
            self._stop.set()
            self._pause.set()
            self._set_exclude(False)
            self._stop_worker()
            try:
                self._renderer.close()
            except Exception:
                pass
            if IS_WIN:
                ctypes.windll.winmm.timeEndPeriod(1)
        finally:
            self.root.destroy()
        return "break"

    # ---- 边缘缩放 / 拖动 ----

    def _edge_at(self, x, y):
        # 小窗**不参与拉伸**（用户要求）：四周既不出缩放光标，也拉不动
        if self._mini or self._collapsed:
            return None
        w, h = self.root.winfo_width(), self.root.winfo_height()
        # 圆角是透明的，鼠标落在最外侧时命中的是 DWM 非客户区；
        # 命中带放宽到 20px，用户不必精确到 1px 也能拖边缘/四角。
        edge, corner = 20, 32
        # 主体玻璃的下沿：再往下那条是**透明的图标条**（两个圆按钮浮在桌面上），
        # 透明像素连鼠标事件都收不到，所以缩放判定只能到这条线为止。
        try:
            body_bottom = self._geo.slabs[1][3]   # 主体下沿（最后一块是按钮窄玻璃）
        except Exception:
            body_bottom = int(self._geo.height) - SLAB_OUT
        # **只有历史消息区里才给拉伸判定**（用户要求）：
        # 底部那条按钮/输入条区域、标题栏都不许出现缩放光标。
        try:
            body_top = self._geo.slabs[1][1]
        except Exception:
            body_top = MSG_TOP
        if y < body_top - 6 or y > body_bottom:
            return None
        if x <= corner and y <= corner:
            return "nw"
        if x >= w - corner and y <= corner:
            return "ne"
        if y <= edge:
            return None          # 顶部中间只拖动，不缩放
        # **主体下沿那 14px = 把窗拉长的手柄**（用户要求：放在消息区下侧）
        if (body_bottom - 16 <= y <= body_bottom - 2
                and SLAB_OUT + 22 <= x <= w - SLAB_OUT - 22):
            return "s"
        if y >= body_bottom - 1:
            return None          # 透明图标条 / 窗口底边：不判缩放
        if x <= edge:
            return "w"
        # 右侧：**只认最外面那 20px**，而且要在滚动条命中带之外。
        # 滚动条画在 `w - SLAB_OUT - 16`，命中半径 7 → 外沿约 `w - 21`；
        # 缩放从 `w - 20` 起算，两者刚好不重叠（用户要求分开）。
        if x >= w - edge and x > w - SLAB_OUT - 16 + 8:
            return "e"
        return None

    @staticmethod
    def _cursor_for(mode):
        return {"nw": "size_nw_se", "se": "size_nw_se",
                "ne": "size_ne_sw", "sw": "size_ne_sw",
                "w": "size_we", "e": "size_we",
                "n": "size_ns", "s": "size_ns"}.get(mode, "")

    def _hover(self, e):
        """**普通鼠标移动**（没按键）走这里 —— 悬停提示就挂在这一条上。

        以前我把提示的判定写进了 `_motion`，而 `_motion` 绑的是 `<B1-Motion>`
        （按住键才触发），所以真实使用中鼠标扫过去一点反应都没有。
        """
        if self._resize:
            return
        try:
            self.canvas.config(cursor=self._cursor_for(self._edge_at(e.x, e.y)))
        except Exception:
            pass
        if not getattr(self, "_drag", None) and not self._resize:
            try:
                self._update_hover_tip(e.x, e.y)
            except Exception:
                pass

    def _leave(self, _e):
        self._mouse_over = False
        self._hide_native_tip()
        if getattr(self, "_tip", None) is not None:
            self._tip = None
            try:
                self.canvas.delete("hdr")
                self._draw_header()
                self.text.refresh()
            except Exception:
                pass
        if not self._resize:
            self.canvas.config(cursor="")

    def _press(self, e):
        # 每次按下先把屏幕布局重新读一遍：拖动前插/拔显示器也能立刻生效
        self._sync_screens()
        # 每次按下都算"有事发生"：自动缩小不该在用户正操作时触发
        self._auto_at = time.time()
        # 点到别处就收弹条；点「字」自己那下留给它做开关（否则会收起又立刻弹出来）
        if getattr(self, "_text_popup", None) is not None:
            try:
                (tcx, tcy), _m, _cy = self._input_points()
                on_text_btn = (abs(e.x - tcx) <= self.INPUT_BTN_R + 5
                               and abs(e.y - tcy) <= self.INPUT_BTN_R + 5)
            except Exception:
                on_text_btn = False
            if not on_text_btn:
                self._close_text_popup()
        # 小悬浮窗：先看六个圆按钮
        if self._mini:
            hit = self._mini_hit(e.x, e.y)
            if hit:
                self._mini_action(hit)
                return
            # 面板下面那两个圆（和大窗同一套绘制，判定也同一套公式）
            try:
                (tcx, tcy), (mcx, mcy), _cy = self._mini_input_points()
            except Exception:
                tcx = tcy = mcx = mcy = -99
            if abs(e.x - tcx) <= self.INPUT_BTN_R + 4 and abs(e.y - tcy) <= self.INPUT_BTN_R + 4:
                self._toggle_text_input()
                return
            if abs(e.x - mcx) <= self.INPUT_BTN_R + 4 and abs(e.y - mcy) <= self.INPUT_BTN_R + 4:
                self._mic_press()
                return
            self._drag = (e.x_root - self.root.winfo_x(),
                          e.y_root - self.root.winfo_y())
            return
        # 收起三角（判定框贴着图案本身）
        rect = getattr(self, "_hit_collapse", None)
        if rect and rect[0] <= e.x <= rect[2] and rect[1] <= e.y <= rect[3]:
            self.toggle_collapse()
            return
        # 标题栏第 3 个按钮（圆形判定）
        if self._btn3_hit(e.x, e.y):
            self._toggle_btn3()
            return
        # 标题栏那两格：点「正在陪看」开/停，点「焦点·DSH」开/关自动续看
        for rect, handler in ((getattr(self, "_hit_watch", None), self._toggle_watch_click),
                              (getattr(self, "_hit_resume", None), self._toggle_resume_click),
                              (getattr(self, "_hit_mini", None),
                               lambda: self._apply_mode(MODE_MINI, save=True))):
            if rect and rect[0] <= e.x <= rect[2] and rect[1] <= e.y <= rect[3]:
                handler()
                return
        # 音量条：**按下就要开始拖**。以前这里没拦住，按一下就落到最外层的
        # "拖窗口"分支里 —— 表现就是"只能点一下，滑不动"。
        if self._vol_hit(e.x, e.y):
            self._vol_drag = True
            self._cancel_vol_hide()
            self._set_volume(self._volume_at(e.y, self._mute_anchor()))
            return
        # 「♪」本身：切换静音（别让它变成拖窗）
        _mute_box = getattr(self, "_hit_mute", None)
        if _mute_box and (e.x - _mute_box[0]) ** 2 + (e.y - _mute_box[1]) ** 2 \
                <= (_mute_box[2] + 1) ** 2:
            self._toggle_mute_click()
            return
        # 滚动条：点/拖都能滚（用户：鼠标无法操作滚动条）
        if self._sbar_hit(e.x, e.y):
            self._sbar_drag = True
            self._scroll_to_y(e.y, drag=True)
            return
        # 输入栏的两个圆按钮
        (tcx, tcy), (mcx, mcy), _cy = self._input_points()
        if abs(e.x - tcx) <= self.INPUT_BTN_R + 5 and abs(e.y - tcy) <= self.INPUT_BTN_R + 5:
            self._toggle_text_input()
            return
        if abs(e.x - mcx) <= self.INPUT_BTN_R + 5 and abs(e.y - mcy) <= self.INPUT_BTN_R + 5:
            self._mic_press()
            return
        # **边缘优先**：输入栏现在和主体同宽，一直铺到左右边和底边，
        # 先判输入栏的话就把"拉大拉小"那一圈全吃掉了（用户实测：拉不长了）。
        mode = self._edge_at(e.x, e.y)
        if mode:
            self._resize = (mode, e.x_root, e.y_root,
                            self.root.winfo_x(), self.root.winfo_y(),
                            self.root.winfo_width(), self.root.winfo_height())
            self._drag = None
            self._pause.set()
            return
        x0, y0, x1, y1, _r = self._geo.input_shape
        if x0 + 22 <= e.x <= x1 - 22 and y0 <= e.y <= y1:
            self._focus_input()
            return
        self._drag = (e.x_root - self.root.winfo_x(),
                      e.y_root - self.root.winfo_y())

    def _move_bubble_win(self) -> None:
        """拖动小窗时，让旁边那个气泡窗口跟着走（原来要松手才刷新）。"""
        try:
            win = getattr(self, "_bubble_win", None)
            if win is None:
                return
            hh = win.winfo_height()
            if hh <= 1:
                return
            x, y = self._bubble_pos(hh)
            win.geometry(f"+{int(x)}+{int(y)}")
        except Exception:
            pass

    def _shift_bubble_win(self, dx: int, dy: int) -> None:
        """气泡窗口跟着主窗做同样的位移（增量移动，不重算绝对坐标）。"""
        try:
            win = getattr(self, "_bubble_win", None)
            if win is None:
                return
            x = win.winfo_x() + int(dx)
            y = win.winfo_y() + int(dy)
            win.geometry(f"+{x}+{y}")
        except Exception:
            pass

    def _motion(self, e):
        self._mouse_over = True
        self._mini_last_mouse = time.time()
        if getattr(self, "_sbar_drag", False):
            self._scroll_to_y(e.y, drag=True)
            return
        if self._vol_drag:
            # 音量条按下后跟着手走：节流 30ms，不然每像素重排一次整窗
            now = time.time()
            if now - getattr(self, "_vol_at", 0.0) < 0.03:
                return
            self._vol_at = now
            self._set_volume(self._volume_at(e.y, self._mute_anchor()))
            return
        if self._resize:
            mode, sx, sy, x0, y0, w0, h0 = self._resize
            dx, dy = e.x_root - sx, e.y_root - sy
            nw, nh, nx, ny = w0, h0, x0, y0
            # 缩放边界 = 虚拟桌面（多显示器），不是主屏
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            if "e" in mode:
                nw = max(MIN_W, min(max(MIN_W, vx + vw - x0), w0 + dx))
            if "w" in mode:
                nw = max(MIN_W, min(max(MIN_W, x0 + w0 - vx), w0 - dx))
                nx = x0 + w0 - nw
            if "s" in mode:
                nh = max(MIN_H, min(max(MIN_H, vy + vh - y0), h0 + dy))
            if "n" in mode:
                nh = max(MIN_H, min(max(MIN_H, y0 + h0 - vy), h0 - dy))
                ny = y0 + h0 - nh
            nx = max(vx, min(nx, max(vx, vx + vw - nw)))
            ny = max(vy, min(ny, max(vy, vy + vh - nh)))
            self.root.geometry(f"{nw}x{nh}+{nx}+{ny}")
            now = time.time()
            # 60fps 节流（以前是 40ms=25fps）：拖动时窗口尺寸每帧都被系统改一次，
            # 重排要是不跟手，中间那几十毫秒就是"旧画面被拉伸"——看着就是闪。
            if now - self._preview_at >= 0.016:
                self._preview_at = now
                self._preview_resize(nw, nh)
                self._relayout_text_popup()
            return
        if self._drag:
            # 拖到屏幕外时窗口坐标会变负，抓屏区域随之越界（高度算出负数），
            # 背景永远画不出来 —— 表现为花屏。必须钳位。
            # 边界是虚拟桌面而不是主屏：第二块屏在主屏左边时坐标本来就是负的，
            # 老代码 max(0, …) 等于把窗口钉死在一块屏里。
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            nx = e.x_root - self._drag[0]
            ny = e.y_root - self._drag[1]
            nx = max(vx, min(nx, max(vx, vx + vw - self.root.winfo_width())))
            ny = max(vy, min(ny, max(vy, vy + vh - self.root.winfo_height())))
            self.root.geometry(f"+{nx}+{ny}")
            self._move_text_popup()
            # 气泡窗口跟着同样的位移走（用增量，不重算坐标 —— 重算那次算错把它挪出屏了）
            try:
                _dx, _dy = nx - self.root.winfo_x(), ny - self.root.winfo_y()
                if _dx or _dy:
                    self._shift_bubble_win(_dx, _dy)
            except Exception:
                pass

    def _release(self, e):
        if getattr(self, "_sbar_drag", False):
            self._sbar_drag = False
            return
        if getattr(self, "_mic_hold", False):
            self._mic_hold_end()
        if self._vol_drag:
            self._vol_drag = False
            self._schedule_hide_volume()
            return
        if self._resize:
            self._resize = None
            self._preview_at = 0.0
            self.root.update_idletasks()
            self._rebuild(max(MIN_W, self.root.winfo_width()),
                          max(MIN_H, self.root.winfo_height()))
            self._sync_pos()
            self._refresh_input_side()
            self._relayout_text_popup()
            self._hover(e)
            return
        self._drag = None
        self._sync_pos()
        self._refresh_input_side()
        if self._mini:
            # 小窗拖完：靠近哪条边就吸上去，并**重新开始**"3 秒没人碰就半藏"的倒计时
            self._mini_snap()
            self._mini_last_mouse = time.time()
            # 吸边可能把窗口带到屏幕的另一半：再刷一次"靠哪边"，
            # 两个圆和它们下面的玻璃垫一起换边（绑在一起动）
            try:
                self._refresh_input_side()
            except Exception:
                pass

    def _enter(self, _e=None):
        """鼠标进窗：算"有人在看"，并把半藏的小悬浮窗拉回来。"""
        self._mouse_over = True
        self._mini_last_mouse = time.time()
        self._auto_at = time.time()
        if self._mini and getattr(self, "_mini_peeked", False):
            self._mini_peeked = False
            self._mini_glide(False)

    def run(self):
        self.root.bind("<Escape>", self._close)
        self.root.bind("<MouseWheel>", self._wheel)
        self.root.bind("<Motion>", self._hover, add="+")
        self.root.bind("<Enter>", self._enter, add="+")
        self.root.bind("<Leave>", self._leave, add="+")
        self.root.bind("<ButtonPress-1>", self._press, add="+")
        self.root.bind("<B1-Motion>", self._motion, add="+")
        self.root.bind("<ButtonRelease-1>", self._release, add="+")
        self.root.mainloop()


if __name__ == "__main__":
    LiveGlass().run()
