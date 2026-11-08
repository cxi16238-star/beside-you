#!/usr/bin/env python3
"""
indicator.py — 采集期间的常亮指示框（贴边光晕 + 顶部状态条）。

外观参照 computer-use-linux 的活动指示窗，只是节奏不同：
  - 屏幕四边各一条 EDGE=26 逻辑像素的渐变光晕（贴边 alpha 0.55 → 35% 处 0.18 → 内缘 0）
  - 顶部居中一条状态条：强调色圆点 + 「…正在看屏幕」+ `see_now`
computer-use-linux 是"每次动作淡入淡出"，这里是**采集期间一直亮着、不闪**。

采集时会把这几条边裁掉（Node 侧按 `dpr` 算成设备像素传给 gst 的 videocrop），
所以模型收到的图里没有框和条，而用户屏幕上有。

契约：启动后往 **stdout 打一行 JSON**，告诉父进程缩放比和几何，用于算裁剪：
  {"ready":true,"dpr":1.7,"geometry":[0,0,2560,1600],"edge":26,"top":55}

置顶：Wayland 的 xdg_toplevel 没有"总在最前"，Qt 的 WindowStaysOnTopHint 在 KWin 上
不生效 —— 由 `kwin-indicator.js` 走 KWin 脚本改 keepAbove（indicator.js 负责加载）。
"""

import json
import os
import signal
import sys

EDGE = 26                 # 四边光晕宽度（逻辑像素）
PILL_TOP = 17             # 状态条距顶部
PILL_H = 38               # 状态条高度
TOP_BAND = PILL_TOP + PILL_H   # 顶部要整体裁掉的高度（=55）
FALLBACK_RGBA = (61, 174, 233)
STOPS = ((0.0, 0.55), (0.35, 0.18), (1.0, 0.0))


def accent_color():
    """跟着系统主题的强调色走：kdeglobals 的 [General] AccentColor；可被环境变量覆盖。"""
    override = os.environ.get("SEE_NOW_INDICATOR_COLOR")
    if override:
        try:
            parts = [int(x) for x in override.replace(",", " ").split()[:3]]
            if len(parts) == 3 and all(0 <= v <= 255 for v in parts):
                return tuple(parts)
        except ValueError:
            pass
    try:
        path = os.path.expanduser("~/.config/kdeglobals")
        section = None
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("["):
                    section = line
                elif section == "[General]" and line.startswith("AccentColor="):
                    parts = [int(x) for x in line.split("=", 1)[1].split(",")[:3]]
                    if len(parts) == 3 and all(0 <= v <= 255 for v in parts):
                        return tuple(parts)
    except (OSError, ValueError):
        pass
    return FALLBACK_RGBA


def title_text():
    return os.environ.get("SEE_NOW_INDICATOR_TITLE") or "DSH 正在看屏幕"


def label_text():
    return os.environ.get("SEE_NOW_INDICATOR_LABEL") or "see_now"


def main():
    die_with_parent()
    from PySide6.QtCore import QPointF, QRectF, Qt, QTimer
    from PySide6.QtGui import (
        QBrush, QColor, QFont, QFontMetricsF, QGuiApplication, QLinearGradient, QPainter, QPen,
    )
    from PySide6.QtWidgets import QApplication, QWidget

    class Glow(QWidget):
        def __init__(self):
            super().__init__(None)
            self._rgba = accent_color()
            self.setWindowFlags(
                Qt.FramelessWindowHint
                | Qt.WindowStaysOnTopHint
                | Qt.WindowTransparentForInput
                | Qt.WindowDoesNotAcceptFocus
                | Qt.Tool
            )
            self.setAttribute(Qt.WA_TranslucentBackground, True)
            self.setAttribute(Qt.WA_ShowWithoutActivating, True)
            self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
            self.fit()
            app = QGuiApplication.instance()
            app.screenAdded.connect(lambda *_: self.fit())
            app.screenRemoved.connect(lambda *_: self.fit())
            app.primaryScreenChanged.connect(lambda *_: self.fit())

        def fit(self):
            scr = self.screen() or QGuiApplication.primaryScreen()
            if scr is not None:
                self.setGeometry(scr.geometry())

        def _gradient(self, x0, y0, x1, y1):
            g = QLinearGradient(x0, y0, x1, y1)
            for pos, a in STOPS:
                g.setColorAt(pos, QColor(*self._rgba, int(round(a * 255))))
            return g

        def paintEvent(self, _event):
            p = QPainter(self)
            p.setRenderHint(QPainter.Antialiasing, False)
            w, h, e = self.width(), self.height(), EDGE
            strips = (
                (QRectF(0, 0, w, e), self._gradient(0, 0, 0, e)),                 # 上
                (QRectF(0, h - e, w, e), self._gradient(0, h, 0, h - e)),         # 下
                (QRectF(0, 0, e, h), self._gradient(0, 0, e, 0)),                 # 左
                (QRectF(w - e, 0, e, h), self._gradient(w, 0, w - e, 0)),         # 右
            )
            for rect, grad in strips:
                p.fillRect(rect, QBrush(grad))
            self._paint_pill(p)

        def _paint_pill(self, p):
            """顶部居中的黑色状态条：强调色圆点 + 「…正在看屏幕」+ `see_now`。"""
            title = title_text()
            label = label_text()

            font_title = QFont()
            font_title.setPixelSize(11)
            font_title.setWeight(QFont.DemiBold)
            fm_title = QFontMetricsF(font_title)

            font_label = QFont()
            font_label.setPixelSize(10)
            font_label.setWeight(QFont.Normal)
            fm_label = QFontMetricsF(font_label)

            pad_x, dot_r, gap = 12.0, 3.5, 7.0
            title_w = fm_title.horizontalAdvance(title)
            label_w = fm_label.horizontalAdvance(label)
            pw = pad_x * 2.0 + dot_r * 2.0 + gap + title_w + gap + label_w
            ph, top = float(PILL_H), float(PILL_TOP)
            x = (self.width() - pw) / 2.0
            rect = QRectF(x, top, pw, ph)
            radius = ph / 2.0
            p.setRenderHint(QPainter.Antialiasing, True)
            p.setPen(Qt.NoPen)

            p.setBrush(QColor(0, 0, 0, 90))
            p.drawRoundedRect(rect.adjusted(0, 2, 0, 2), radius, radius)

            p.setBrush(QColor(23, 23, 25, 219))          # 0.09,0.09,0.11 @ 0.86
            p.drawRoundedRect(rect, radius, radius)

            pen = QPen(QColor(255, 255, 255, 31))         # 白 @ 0.12
            pen.setWidthF(1.0)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)
            p.drawRoundedRect(rect.adjusted(0.5, 0.5, -0.5, -0.5), radius, radius)

            cy = top + ph / 2.0
            dot_x = x + pad_x + dot_r
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(*self._rgba, 56))           # 0.22 光晕
            p.drawEllipse(QPointF(dot_x, cy), dot_r * 2.0, dot_r * 2.0)
            p.setBrush(QColor(*self._rgba, 255))
            p.drawEllipse(QPointF(dot_x, cy), dot_r, dot_r)

            line = fm_title.ascent() + fm_title.descent()
            baseline = top + (ph - line) / 2.0 + fm_title.ascent()
            text_x = dot_x + dot_r + gap
            p.setFont(font_title)
            p.setPen(QColor(255, 255, 255, 242))          # 0.95
            p.drawText(QPointF(text_x, baseline), title)
            p.setFont(font_label)
            p.setPen(QColor(255, 255, 255, 153))          # 0.6
            p.drawText(QPointF(text_x + title_w + gap, baseline), label)

    app = QApplication(sys.argv)
    app.setApplicationName("see-now-indicator")
    app.setDesktopFileName("see-now-indicator")
    w = Glow()
    # 普通窗口会被顶部面板挤掉一截（工作区约束），四边的光晕就断一边。
    # 全屏窗口覆盖整个输出，也天然压在普通窗口之上。
    w.showFullScreen()

    def report():
        scr = w.screen() or QGuiApplication.primaryScreen()
        geo = scr.geometry() if scr else w.geometry()
        dpr = float(scr.devicePixelRatio()) if scr else float(w.devicePixelRatioF())
        print(json.dumps({
            "ready": True,
            "dpr": round(dpr, 4),
            "geometry": [geo.x(), geo.y(), geo.width(), geo.height()],
            "edge": EDGE,
            "top": TOP_BAND,
            "platform": QGuiApplication.platformName(),
        }), flush=True)
        if os.environ.get("SEE_NOW_INDICATOR_DEBUG") == "1":
            print(f"[indicator] platform={QGuiApplication.platformName()} visible={w.isVisible()} "
                  f"screen={scr.name() if scr else None} geo={w.geometry().getRect()} dpr={dpr}",
                  file=sys.stderr, flush=True)

    # 等一帧再报：showFullScreen 之后 screen() 才稳定
    QTimer.singleShot(250, report)

    # Python 信号处理器只在解释器跑字节码时才执行；静态画面下 Qt 事件循环可能很久
    # 不回调 Python，SIGTERM 就一直挂着（孤儿窗的根因）。空转定时器保证定期回到解释器。
    beat = QTimer()
    beat.timeout.connect(lambda: None)
    beat.start(200)

    for sig in (signal.SIGINT, signal.SIGTERM):
        # 直接 os._exit：Qt 事件循环里 app.quit() 不保证及时执行（之前就是这样留下孤儿窗）
        signal.signal(sig, lambda *_: os._exit(0))
    sys.exit(app.exec())


def die_with_parent():
    """父进程（node）死了就跟着退出，避免留下孤儿光晕窗。"""
    try:
        import ctypes
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, signal.SIGKILL)      # PR_SET_PDEATHSIG = 1
    except Exception:
        pass
    if os.getppid() == 1:
        sys.exit(0)


if __name__ == "__main__":
    main()
