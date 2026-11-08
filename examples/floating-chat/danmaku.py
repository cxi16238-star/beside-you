#!/usr/bin/env python3
"""弹幕层：一条横跨屏幕的透明带，消息从右往左飘过去。

**为什么是独立窗口**：主窗（`window.py`）是 240x78（迷你）或 760x560（完整）的
矩形，Tk 没有窗口 region —— 文字没法飘出窗口边界。所以这里单开一个
`Toplevel`，横跨整屏、只有两条轨道那么高。

三条硬约束（都是实测过的，别省）：

1. **必须加 `WS_EX_TRANSPARENT`**。`-transparentcolor` 走的是 `LWA_COLORKEY`，
   它只让"纯键色"的像素点穿；文字本身是抗锯齿像素，不加这条就会吃掉游戏里的
   点击（点到弹幕那一行 = 丢一次输入）。
2. **不能同时用 `-alpha`**：Tk 在 Windows 上 `-transparentcolor` 与 `-alpha`
   对同一个窗口互斥。半透明靠"深色描边 + 主色字"两层文字实现。
3. **队列空了就不排下一次 after**。打游戏时没消息必须是真的 0 调用，而不是
   每帧空转。实测 30fps / 4 条 item 单帧 0.19ms，空转则是白烧。

`root.withdraw()` 之后本层仍然可见（实测 `winfo_viewable()` 返回 1），
所以"隐藏主窗、只留弹幕"这条路是通的。

自检：`python danmaku.py` 跑 3.6 秒演示并落一张截图，不影响仓库其它文件。
"""
from __future__ import annotations

import os
import time
import tkinter as tk
import tkinter.font as tkfont

# 与 glass_geometry.KEY 一致：窗口底色 = 这个值的地方被抠成透明
KEY = "#010203"

GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000

LANE_H = 26           # 单轨高度（13px 字 + 上下留白）
PAD_Y = 8
TICK_MS = 33          # 30fps。60fps 实测 1.28ms/帧，打游戏时没必要
SPEED = 220.0         # px/s。160 时一条 400px 的字要 2.5 秒才完全进屏，用户只能看到尾巴；220 约 1.8 秒
                      # 2560 屏约 12 秒穿完，够读完又不拖沓
GAP = 32              # 同轨两条之间的最小空隙
PENDING_MAX = 6       # 排队上限，超了丢新的（宁可漏一条，不要糊满屏）
UNITS_MAX = 42        # 显示宽度预算：中文 1、其余 0.55，42 字约 714px

FG = "#eaf2ff"
SHADOW = "#0a1018"
FONT_FAMILY = "Microsoft YaHei UI"
FONT_SIZE = 13


def _units(ch: str) -> float:
    """全角算 1，半角算 0.55 —— 按字符数截断会让英文短句显得很长。"""
    return 1.0 if ord(ch) > 0x2E7F else 0.55


def clip(text: str, limit: float = UNITS_MAX) -> str:
    """压成单行并按显示宽度截断。"""
    line = " ".join(str(text or "").split())
    if not line:
        return ""
    total = 0.0
    for i, ch in enumerate(line):
        total += _units(ch)
        if total > limit:
            return line[:i] + "…"
    return line


class DanmakuLayer:
    """一条透明带 + 若干轨道。对外只有 push / set_options / close。"""

    def __init__(self, root: tk.Tk, *, screen_w: int, screen_h: int,
                 edge: str = "top", lanes: int = 2, speed: float = SPEED,
                 inset: int = 0):
        self.root = root
        self.screen_w = max(320, int(screen_w))
        self.screen_h = max(240, int(screen_h))
        self.edge = "bottom" if edge == "bottom" else "top"
        self.lanes = max(1, min(3, int(lanes)))
        self.speed = max(40.0, min(400.0, float(speed)))
        self.inset = max(0, int(inset))

        self._pending = []
        self._items = []          # [{main, shadow, x, w, lane}]
        self._job = None
        self._last = 0.0
        self.spawned = 0
        self.dropped = 0
        self.ticks = 0            # 诊断用：走一帧 +1（拿它算实际帧率）
        self.closed = False

        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.win.configure(bg=KEY)
        # 非 Windows（mac/Linux）没有这个属性，静默退化成一块深色条：宁可难看，
        # 不能因为一行 wm attribute 让整个窗口起不来（#45 / PR #38 的教训）。
        try:
            self.win.attributes("-transparentcolor", KEY)
        except Exception:
            pass

        self.canvas = tk.Canvas(self.win, bg=KEY, highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        # 自己量宽度而不是问 `canvas.bbox()`：刚 create_text 出来的 item 还没排过版，
        # bbox 可能给 None / 旧值，那样 GAP 会算小、同轨两条直接叠上。
        self._font = tkfont.Font(root=root, family=FONT_FAMILY, size=FONT_SIZE)
        self._resize()
        self._apply_ex_style()

    # ---- 几何与外观 ----

    @property
    def height(self) -> int:
        return self.lanes * LANE_H + 2 * PAD_Y

    def _resize(self) -> None:
        y = (self.screen_h - self.height - self.inset) if self.edge == "bottom" else self.inset
        try:
            self.win.geometry(f"{self.screen_w}x{self.height}+0+{y}")
            self.canvas.config(width=self.screen_w, height=self.height)
        except Exception:
            pass

    def _apply_ex_style(self) -> None:
        """点穿 + 不抢焦点 + 不进任务栏。只在 Windows 上存在。"""
        if os.name != "nt":
            return
        try:
            import ctypes
            u = ctypes.windll.user32
            hwnd = u.GetAncestor(self.win.winfo_id(), 2)
            ex = int(u.GetWindowLongW(hwnd, GWL_EXSTYLE))
            u.SetWindowLongW(hwnd, GWL_EXSTYLE,
                             ex | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)
        except Exception as exc:
            print("danmaku exstyle failed", repr(exc), flush=True)

    def set_options(self, *, edge=None, lanes=None, speed=None, inset=None) -> None:
        """配置改了就地生效：不清屏、不重开窗口（用户的观感是"字变快了"）。"""
        if edge is not None:
            self.edge = "bottom" if str(edge).lower() == "bottom" else "top"
        if lanes is not None:
            self.lanes = max(1, min(3, int(lanes)))
        if speed is not None:
            self.speed = max(40.0, min(400.0, float(speed)))
        if inset is not None:
            self.inset = max(0, int(inset))
        self._resize()

    # ---- 输入 ----

    def push(self, text, role: str = "assistant") -> bool:
        """进队。自己说的话不飘（用户不需要再读一遍自己的输入）。"""
        if str(role or "").lower() in ("user", "me", "human"):
            return False
        line = clip(text)
        if not line or self.closed:
            return False
        if len(self._pending) >= PENDING_MAX:
            self.dropped += 1
            return False
        self._pending.append(line)
        self._ensure_running()
        return True

    # ---- 调度 ----

    def _lane_free(self, lane: int) -> bool:
        """该轨最后一条的尾巴已经离开屏幕右侧 → 可以放新的。"""
        tail = None
        for it in self._items:
            if it["lane"] == lane and (tail is None or it["x"] > tail["x"]):
                tail = it
        return tail is None or tail["x"] + tail["w"] + GAP <= self.screen_w

    def _spawn(self) -> None:
        if not self._pending:
            return
        lane = None
        for i in range(self.lanes):
            if self._lane_free(i):
                lane = i
                break
        if lane is None:
            return
        text = self._pending.pop(0)
        y = PAD_Y + lane * LANE_H
        kwargs = dict(text=text, anchor="nw", font=(FONT_FAMILY, FONT_SIZE))
        shadow = self.canvas.create_text(self.screen_w + 1, y + 1, fill=SHADOW, **kwargs)
        main = self.canvas.create_text(self.screen_w, y, fill=FG, **kwargs)
        width = self._font.measure(text)
        self._items.append({"main": main, "shadow": shadow, "x": float(self.screen_w),
                            "w": width, "lane": lane})
        self.spawned += 1

    def _ensure_running(self) -> None:
        if self._job is not None or self.closed:
            return
        self._last = time.perf_counter()
        try:
            self._job = self.win.after(TICK_MS, self._loop)
        except Exception:
            self._job = None

    def _loop(self) -> None:
        self._job = None
        if self.closed:
            return
        self.ticks += 1
        now = time.perf_counter()
        dt = max(0.0, min(0.2, now - self._last))   # 卡顿/休眠回来别让字瞬移
        self._last = now
        dx = self.speed * dt

        for it in list(self._items):
            it["x"] -= dx
            self.canvas.move(it["main"], -dx, 0)
            self.canvas.move(it["shadow"], -dx, 0)
            if it["x"] + it["w"] < 0:
                self.canvas.delete(it["main"])
                self.canvas.delete(it["shadow"])
                self._items.remove(it)

        if len(self._items) < self.lanes * 2:
            self._spawn()

        if self._items or self._pending:
            try:
                self._job = self.win.after(TICK_MS, self._loop)
            except Exception:
                self._job = None
        # 两条都空 → 不排下一次，CPU 归零

    # ---- 生命周期 ----

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self._job is not None:
            try:
                self.win.after_cancel(self._job)
            except Exception:
                pass
            self._job = None
        try:
            self.win.destroy()
        except Exception:
            pass

    @property
    def alive(self) -> bool:
        return not self.closed


def _self_test() -> None:
    """给人看的演示，不是测试用例：python danmaku.py 会自己关掉。"""
    root = tk.Tk()
    root.withdraw()
    layer = DanmakuLayer(root, screen_w=root.winfo_screenwidth(),
                         screen_h=root.winfo_screenheight(), edge="top", lanes=2)
    script = [
        (0.00, "这条要能看见，但鼠标点上去必须穿透"),
        (0.30, "第二轨：独占全屏里它看不见，这是 DWM 的规矩"),
        (0.60, "第三句会被限流挡一下，不会叠成一坨"),
        (0.90, "很长的消息会被截断到四十二个字，超过这个长度对「扫一眼」没有意义，剩下的话请展开看"),
        (1.30, "第四条"),
        (1.60, "第五条"),
        (1.90, "第六条"),
        (2.20, "第七条"),
    ]
    t0 = time.perf_counter()

    def pump():
        elapsed = time.perf_counter() - t0
        while script and elapsed >= script[0][0]:
            layer.push(script.pop(0)[1])
        if elapsed < 3.6:
            root.after(60, pump)
        else:
            print("generated=%d dropped=%d pending=%d onscreen=%d"
                  % (layer.spawned, layer.dropped, len(layer._pending), len(layer._items)))
            layer.close()
            root.after(60, root.destroy)

    root.after(60, pump)
    root.mainloop()


if __name__ == "__main__":
    _self_test()
