"""pick_region.py — 全屏遮罩上拖一个矩形，把屏幕坐标交给插件。

为什么要它：`region:"x,y,w,h"` 让**用户**去量像素是不现实的。这里给一个
「截图工具」那样的交互：屏幕变暗、拖框、松手确认，插件拿到物理像素矩形。

三条约定（改了会跟 Node 侧对不上）：

1. **stdout 只输出一行 JSON**：`{"x":..,"y":..,"w":..,"h":..}`。取消 = 什么都不输出，
   退出码 2。Node 侧只认这个。
2. **坐标必须是物理像素**。Windows 上 Tk 的坐标是**逻辑像素**，150% 缩放下会小一圈，
   拿去做 gdigrab `-offset_x` 会偏。所以在建窗之前先声明 per-monitor v2 DPI 感知，
   让 Tk 直接工作在物理像素坐标系里（跟 window.py 同一个做法）。
3. **只覆盖主屏**。虚拟桌面起点可能是负坐标（副屏在主屏左边），Tk 的
   `+x+y` 表达不了负偏移，而 gdigrab 也不接受负 offset。与其给一个错的矩形，
   不如明确说"请在主屏里框"。
"""

from __future__ import annotations

import ctypes
import json
import os
import sys

# ---- DPI：必须在 import tkinter 建窗之前声明 -------------------------------------

def _dpi_aware() -> None:
    """声明 per-monitor v2。失败就往下退，退到不了就按逻辑像素跑（会偏，但能跑）。"""
    try:
        # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2，Win10 1703+
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        pass


_dpi_aware()

import tkinter as tk  # noqa: E402  —— 必须在 _dpi_aware() 之后

MIN_SIDE = 24          # 小于这个边长当作误触，不确认


def scale_rect(rect, screen, stream):
    """把 Tk 屏幕坐标换算成**采集流坐标**。

    Linux 上 Tk 走 XWayland，报的是设备像素（例 2560×1600），而 portal 的流是
    逻辑像素（例 2048×1280）。不换算的话，框出来的区域会整体偏大 —— 用户以为
    框住了窗口，模型看到的却是窗口右下角那一块。

    实测三组（同一台 2560×1600 屏）：

        缩放 125%：Tk 2560×1600 → 流 2048×1280（×1.25）
        缩放 150%：Tk 2560×1600 → 流 1707×1067（×1.5）
        GNOME/X11 100%（1280×800）：两者相同（×1.0）

    所以比例是 `stream / screen`，**不假设它是整数**；x/y 各自换算，算完再夹回
    `[0, 流尺寸]`（缩放变化后旧坐标可能越界）。

    两边都缺、或者比例是 1，就原样返回（Windows 上就是这样：Tk 已经按
    物理像素工作，stream 参数也不会传进来）。
    """
    if not rect or not screen or not stream:
        return rect
    sw, sh = screen
    tw, th = stream
    if not sw or not sh or not tw or not th:
        return rect
    x, y, w, h = rect
    sx, sy = tw / sw, th / sh
    return (
        max(0, min(tw - 1, round(x * sx))),
        max(0, min(th - 1, round(y * sy))),
        max(1, min(tw, round(w * sx))),
        max(1, min(th, round(h * sy))),
    )
ACCENT = "#4da3ff"


def main() -> int:
    stream_wh = None
    if "--stream-width" in sys.argv and "--stream-height" in sys.argv:
        try:
            stream_wh = (int(sys.argv[sys.argv.index("--stream-width") + 1]),
                         int(sys.argv[sys.argv.index("--stream-height") + 1]))
        except (ValueError, IndexError):
            stream_wh = None

    root = tk.Tk()
    root.withdraw()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()

    win = tk.Toplevel(root)
    win.overrideredirect(True)
    win.geometry(f"{sw}x{sh}+0+0")
    win.attributes("-topmost", True)
    # 半透明黑遮罩：既能看清要框的东西，又能看清自己框到哪
    win.attributes("-alpha", 0.28)
    win.configure(bg="#000000", cursor="crosshair")

    canvas = tk.Canvas(win, width=sw, height=sh, bg="#000000",
                       highlightthickness=0, cursor="crosshair")
    canvas.pack(fill="both", expand=True)
    canvas.create_text(sw // 2, 28, fill="#dbe7f5", font=("Microsoft YaHei UI", 12),
                       text="拖动框出要给它看的那一块 · 松手确认 · Esc 取消")
    # 遮罩是半透明的，选框要**不透明**地再画一遍，否则框里框外一样暗
    box = canvas.create_rectangle(0, 0, 0, 0, outline=ACCENT, width=2, state="hidden")
    fill = canvas.create_rectangle(0, 0, 0, 0, outline="", fill=ACCENT,
                                   stipple="gray12", state="hidden")
    size_label = canvas.create_text(0, 0, fill="#ffffff", anchor="nw",
                                    font=("Consolas", 10), state="hidden")

    state = {"x0": 0, "y0": 0, "dragging": False, "rect": None}

    def on_press(e):
        state.update(x0=e.x, y0=e.y, dragging=True, rect=None)
        for item in (box, fill, size_label):
            canvas.itemconfigure(item, state="hidden")

    def on_drag(e):
        if not state["dragging"]:
            return
        x0, y0 = state["x0"], state["y0"]
        x1, y1 = e.x, e.y
        x, y = min(x0, x1), min(y0, y1)
        w, h = abs(x1 - x0), abs(y1 - y0)
        state["rect"] = (x, y, w, h)
        canvas.coords(box, x, y, x + w, y + h)
        canvas.coords(fill, x, y, x + w, y + h)
        canvas.coords(size_label, x + 6, y + 6)
        canvas.itemconfigure(size_label, text=f"{w}×{h}  ({x},{y})")
        for item in (box, fill, size_label):
            canvas.itemconfigure(item, state="normal")

    def confirm(_e=None) -> None:
        rect = state["rect"]
        if not rect:
            return
        x, y, w, h = rect
        if w < MIN_SIDE or h < MIN_SIDE:
            return                     # 误触：留着让用户接着拖
        # 先把 Tk 屏幕坐标换算到采集流坐标（Linux 上两者不是 1:1）
        x, y, w, h = scale_rect((x, y, w, h), (sw, sh), stream_wh)
        print(json.dumps({"x": x, "y": y, "w": w, "h": h,
                          "screen": [sw, sh], "stream": list(stream_wh) if stream_wh else None}),
              flush=True)
        root.destroy()

    def cancel(_e=None) -> None:
        root.destroy()
        raise SystemExit(2)

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    canvas.bind("<ButtonRelease-1>", confirm)
    canvas.bind("<Button-3>", cancel)
    win.bind("<Escape>", cancel)
    win.bind("<Return>", confirm)
    win.after(200, lambda: win.focus_force())

    # 自检：真的走一遍 press/motion/release（不绕过 Tk 的事件），用来在没有人的时候
    # 验证「拖一下能拿到 x,y,w,h」。只在显式设了 DSH_PICK_SELFTEST 时跑。
    if os.environ.get("DSH_PICK_SELFTEST") == "1":
        def _selftest():
            box_x0, box_y0, box_x1, box_y1 = 100, 120, 100 + 400, 120 + 500
            canvas.event_generate("<ButtonPress-1>", x=box_x0, y=box_y0)
            canvas.event_generate("<B1-Motion>", x=box_x1, y=box_y1)
            canvas.event_generate("<ButtonRelease-1>", x=box_x1, y=box_y1)
        win.after(600, _selftest)

    try:
        root.mainloop()
    except SystemExit as e:
        return int(e.code or 0)
    # mainloop 正常退出 = 用户确认过（print 已发）或直接关掉；取消走 SystemExit
    rect = state["rect"]
    if rect and not sys.stdout.closed:
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
