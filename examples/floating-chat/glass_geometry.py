"""glass_geometry.py — 悬浮窗玻璃的全部尺寸相关贴图，纯计算、无 Tk。

原来的 `window.py` 把 `W/H/SHAPES/MASK/OVERLAY/WARP_X/BOX_MAPS/...` 十几个量
挂成模块全局，靠 `global` 语句在 `rebuild_geometry()` 里一次性改写。副作用是：

- 任何模块都能读写它们，改一个尺寸要先数清楚谁在被引用；
- `import` 的那一刻就按默认尺寸建好一整套图，缩放/折叠都要再跑一遍；
- GPU 伴生文件只能 `import window as G` 去读全局，拿到的可能是「上一帧的尺寸」。

这里改成不可变值对象：`Geometry.for_size(w, h)` 给出完整一套；
气泡宽度变了就 `geo.with_shapes(shapes)` —— 尺寸相关的遮罩/折射图直接复用，
不需要重建。谁要什么就传 `geo` 进去，不再有隐式共享状态。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw

# ---- 布局常量（改这些等于改外观，改完必须截图对比） ----
DEFAULT_W, DEFAULT_H = 760, 560
MIN_W, MIN_H = 480, 420
CORNER_R = 58
BAR_FRAC = 0.55
BAR_Y = 20
BAR_THICK = 4
# 抠色键：窗口背景色 = 这个值的地方被 Tk 的 -transparentcolor 抠成透明。
KEY = "#010203"

MESSAGE_SLOTS = 4          # 兼容用（ChatFeed 的滚动步长等），真正的槽位数看 `msg_slots()`
MSG_TOP = 104              # 消息区上沿（标题栏下面）
MSG_BOTTOM_MARGIN = 12     # 消息区下沿到图标条的距离（那 12px 是"拉长"手柄）
INPUT_STRIP_H = 80         # 窗口底部留给两个圆按钮的**透明条**（不铺玻璃）
SLAB_OUT, SLAB_TOP_H, SLAB_BOT_H = 12, 54, 70
SLAB_GAP = 10
SLAB_RADIUS = 22

# 气泡底板：文字底下是实时视频，对比度每秒都在变；给每块气泡铺一层深色，
# 文字的对比度就只由这层决定，不再跟着画面走。alpha 0.50（128/255）——
# 白字压在纯白画面上也能到 4.2:1，达到正文可读的下限；再低（0.40）只有 2.9:1。
# `DSH_GLASS_PLATE=0` 关掉（只用于新旧对比截图，正常别用）。
PLATE = os.environ.get("DSH_GLASS_PLATE", "1") != "0"
BUBBLE_PLATE = (7, 17, 29, 128) if PLATE else (0, 0, 0, 0)
# 气泡底板的不透明度（0~255）。128 是设计值：白字压在纯白画面上仍有 4.2:1。
# 用户能单独调它（`bubbleOpacity`），所以做成可变 —— `_overlay()` 每次都读，
# 窗口改完让几何重建一次就生效。
PLATE_ALPHA = 128
PLATE_RGB = (7, 17, 29)          # 气泡底板颜色（跟着设置里的「气泡颜色」走）


def set_plate_color(value) -> None:
    """`#rrggbb` 或 (r,g,b) → 气泡底板颜色。"""
    global PLATE_RGB
    try:
        if isinstance(value, str) and value.startswith("#") and len(value) == 7:
            PLATE_RGB = (int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16))
        elif isinstance(value, (tuple, list)) and len(value) >= 3:
            PLATE_RGB = (int(value[0]), int(value[1]), int(value[2]))
    except Exception:
        pass


def set_plate_alpha(value) -> None:
    """改气泡底板的不透明度（0~255）。窗口读 `bubbleOpacity` 后调它。"""
    global PLATE_ALPHA
    try:
        PLATE_ALPHA = max(0, min(255, int(round(float(value)))))
    except (TypeError, ValueError):
        PLATE_ALPHA = 128

# 抓屏时向外扩一圈，边缘透镜才有「框外」的像素可采
PAD = 40
BAND = 64          # 全分辨率下的透镜带宽度
AMP = 30           # 全分辨率下的最大采样偏移
LPF = 4            # 透镜/模糊在 1/4 分辨率上算

BOX_BAND = 7       # 1/4 分辨率下的折射带
BOX_AMP = 8        # 1/4 分辨率下的最大采样偏移

MIC_SIZE = 28
MIC_MARGIN = (53, 67)   # 距左下角

# ---- 小悬浮窗（mini）----
# 两条 54px 的胶囊：上排「静音 / 回到大窗 / 关闭」，下排「语音 / 文字」。
# 高度必须精确 —— `slabs_for(mini=True)` 和窗口的 `MINI_H` 是同一个数。
MINI_ROW_H = SLAB_TOP_H          # 54（大窗标题栏那一档的高度，小窗里当行高用）
MINI_GAP = 10                    # 面板和下面两个圆之间的透明缝
MINI_PANEL_H = 96                # 小窗那块面板的高度（两行：图标行 + 状态行）
MINI_W = 320
MINI_H = SLAB_OUT * 2 + MINI_PANEL_H + MINI_GAP + 66   # 12*2 + 96 + 10 + 66 = 196

Box = tuple[int, int, int, int, int]   # x0, y0, x1, y1, radius


def mini_slabs(w: int, h: int, btns=None) -> tuple[Box, ...]:
    """小悬浮窗：**一整块面板**（用户手绘），下面那段是透明的，放两个圆按钮。"""
    o = SLAB_OUT
    # **按钮带**：和大窗同尺寸（圆的外接框 + 6px）
    if btns and len(btns) >= 4:
        p = 6
        bx0 = max(SLAB_OUT, int(btns[0]) - p)
        by0 = max(SLAB_OUT, int(btns[1]) - p)
        bx1 = min(w - SLAB_OUT, int(btns[2]) + p)
        by1 = min(h - SLAB_OUT, int(btns[3]) + p)
        if bx1 - bx0 > 40 and by1 - by0 > 30:
            return ((o, o, w - o, o + MINI_PANEL_H), (bx0, by0, bx1, by1))
    panel = (o, o, w - o, o + MINI_PANEL_H)
    # **按钮带**：和大窗同一规则（圆的外接框 + 6px），让两个圆也有玻璃垫
    if btns and len(btns) >= 4:
        p = 6
        bx0 = max(o, int(btns[0]) - p)
        by0 = max(o, int(btns[1]) - p)
        bx1 = min(w - o, int(btns[2]) + p)
        by1 = min(h - o, int(btns[3]) + p)
        if bx1 - bx0 > 40 and by1 - by0 > 30:
            return (panel, (bx0, by0, bx1, by1))
    return (panel,)


def slabs_for(w: int, h: int, mini: bool = False, btns=None) -> tuple[Box, ...]:
    """三块独立的玻璃：标题栏 / 主体 / 输入栏，中间留透明缝透出桌面。

    折叠态（高度只有标题栏）只返回那一块 —— 否则主体/输入栏会算出 y1 < y0
    的负高度矩形，PIL 直接抛 `y1 must be greater than or equal to y0`。
    小悬浮窗（mini）是另一种布局：只要两条并排的胶囊，见 `mini_slabs()`。
    """
    if mini:
        return mini_slabs(w, h, btns)
    o = SLAB_OUT
    top = (o, o, w - o, o + SLAB_TOP_H)
    if h < SLAB_TOP_H + 3 * o:
        return (top,)
    # **没有底部那条长玻璃板了**（用户：把历史信息下面那条现有长条去掉）。
    # 而且两个圆按钮要**放在框下面**（用户：不是放在框里面）—— 所以玻璃主体
    # 到 `h - o - INPUT_STRIP_H` 就结束，底下那 80px 是透明的，圆浮在桌面上。
    # 历史区回到原来的高度（用户：延长不能把消息区也拉长）
    body_bottom = max(top[3] + SLAB_GAP + 24, h - o - INPUT_STRIP_H)
    body = (o, top[3] + SLAB_GAP, w - o, body_bottom)
    # **只给底部那两个圆按钮铺一条窄玻璃**（用户：延长别动历史区）。
    # 高度 = 圆形按钮直径 + 上下各 6px，宽度只包住两颗圆和中间那道缝。
    band_h = 2 * 23 + 12                      # INPUT_BTN_R=23，上下留 6
    band_top = h - o - band_h
    if band_top > body_bottom + 2:
        if btns and len(btns) >= 4:
            # btns = (x0, y0, x1, y1)：**直接套住两颗圆**
            x0 = max(o + 2, int(btns[0]))
            y0 = max(o + 2, int(btns[1]))
            x1 = min(w - o - 2, int(btns[2]))
            y1 = min(h - o, int(btns[3]))
            if x1 - x0 >= 60 and y1 - y0 >= 40:
                return (top, body, (x0, y0, x1, y1))
        if btns:
            x0 = max(o + 2, int(btns[0]) - 12)
            x1 = min(w - o - 2, int(btns[2]) + 12)
        else:
            # 没传按钮坐标的路径（预览/抖动帧等）：给一块**居中**的窄带，
            # 宽度约等于两颗圆，避免"有时候突然变回长条"。
            half = min((w - o * 2) / 2.0, 52.0)
            mid = w / 2.0
            x0, x1 = int(mid - half), int(mid + half)
        if x1 - x0 >= 60:
            band = (x0, band_top, x1, h - o)
            return (top, body, band)
    return (top, body)


def msg_slots(h: int) -> int:
    """这一档高度能并排显示**几条消息**（不再固定 4 条）。

    用户原话：「不是平均分给四条，而是显示更多信息」—— 所以槽位数跟着高度长：
    窗口越高，一次能看到的条数越多（每条约 46px 起步）。
    """
    input_top = h - 80
    band = max(0, input_top - MSG_BOTTOM_MARGIN - MSG_TOP)
    return max(1, min(32, band // 46))


def chat_layout(h: int) -> tuple[list[int], int]:
    """消息槽位的 y 起点与高度（占位用；真正常规排版在 `_message_shapes` 里按文字算）。

    槽位**条数**跟着高度走（`msg_slots`），不是永远 4 条。
    """
    input_top = h - 80
    band_top = MSG_TOP
    n = msg_slots(h)
    band_h = max(60, input_top - MSG_BOTTOM_MARGIN - band_top)
    gap = max(6, min(10, band_h // 40))
    bh = max(24, int((band_h - gap * (n - 1)) / n))
    return [band_top + i * (bh + gap) for i in range(n)], bh


def shapes_for(w: int, h: int, mini: bool = False) -> tuple[Box, ...]:
    """内部框的纵向槽位；气泡的最终宽高由文字测量决定（见 window._message_shapes）。

    折叠态（h=78）没有消息区和输入区，返回全零占位：`_box_maps`/`_overlay` 会跳过
    空框，不会在负坐标上算出畸形折射图。小悬浮窗同理 —— 它那两排按钮自己画，
    不需要气泡底板。
    """
    if mini:
        return ((0, 0, 0, 0, 0), (0, 0, 0, 0, 0), (0, 0, 0, 0, 0))
    input_top = h - 80
    if input_top - 40 < SLAB_OUT + SLAB_TOP_H:
        return ((0, 0, 0, 0, 0), (0, 0, 0, 0, 0), (0, 0, 0, 0, 0))
    ys, bh = chat_layout(h)
    boxes = [(38, y, w - 38, y + bh, 30) for y in ys]
    # 输入区：**和主体同宽、同圆角**（用户手绘图：文字输入框要和主体一样的圆角矩形、
    # 长度和位置对齐）。发送键不再画在输入栏里（改成弹条上的按钮），所以这里只留一个框。
    boxes.append((SLAB_OUT, input_top, w - SLAB_OUT, input_top + SLAB_BOT_H, SLAB_RADIUS))
    boxes.append((0, 0, 0, 0, 0))
    return tuple(boxes)


def _rounded_mask(w: int, h: int, boxes: Iterable[Box]) -> Image.Image:
    ss = 4
    m = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(m)
    for x0, y0, x1, y1 in boxes:
        d.rounded_rectangle((x0 * ss, y0 * ss, x1 * ss, y1 * ss),
                            radius=SLAB_RADIUS * ss, fill=255)
    return m.resize((w, h), Image.Resampling.LANCZOS)


def _overlay(w: int, h: int, shapes: tuple[Box, ...], plate: bool = True) -> Image.Image:
    """内部框的染色。气泡铺底板（文字靠它稳住对比度），其余仍是极淡的冷色。

    `plate=False` 用于没有消息的空态：那四个槽位只是占位，铺深色反而像四个空洞。
    """
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    tints = ((235, 242, 255, 5), (110, 175, 255, 14), (235, 242, 255, 4),
             (235, 242, 255, 4), (235, 242, 255, 5), (110, 175, 255, 12))
    for i, ((x0, y0, x1, y1, r), fill) in enumerate(zip(shapes, tints)):
        if i == len(shapes) - 2:
            continue                     # 输入区那条只是命中区，不画底板
        if x1 > x0 and y1 > y0:
            fill = tints[i % len(tints)]
            if plate and PLATE and i < len(shapes) - 2:
                # 向外 1px：内框边缘有折射带，底板正好压在它上面，否则那圈
                # 折射出来的背景色会变成一条彩色描边（亮背景上特别明显）
                d.rounded_rectangle((x0 - 1, y0 - 1, x1 + 1, y1 + 1), radius=r + 1,
                                    fill=(*PLATE_RGB, PLATE_ALPHA))
            else:
                d.rounded_rectangle((x0, y0, x1, y1), radius=r, fill=fill)
    return layer


def _warp_maps(w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    """1/4 分辨率的边缘位移图：真正采样「边界外」的背景，不是描边。

    半径方向向外取样本，越靠边偏移越大，到 BAND 内归零。
    """
    hw, hh = w // LPF, h // LPF
    yy, xx = np.mgrid[0:hh, 0:hw].astype(np.float32)
    r = CORNER_R / LPF
    qx = np.abs(xx - hw / 2) - (hw / 2 - r)
    qy = np.abs(yy - hh / 2) - (hh / 2 - r)
    sdf = (np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
           + np.minimum(np.maximum(qx, qy), 0) - r)
    gy, gx = np.gradient(sdf)
    n = np.maximum(np.hypot(gx, gy), 1e-6)
    d = -sdf
    t = np.clip(1.0 - d / (BAND / LPF), 0.0, 1.0)
    mag = (AMP / LPF) * t * t
    return (xx + gx / n * mag).astype(np.float32), (yy + gy / n * mag).astype(np.float32)


def _box_maps(shapes: tuple[Box, ...], w: int, h: int) -> tuple[tuple, ...]:
    """每个内部框的 alpha / 边缘权重 / 采样坐标，全部在 1/4 分辨率。"""
    out = []
    for x0, y0, x1, y1, r in shapes:
        if x1 <= x0 or y1 <= y0:
            continue
        qx0, qy0 = x0 // LPF, y0 // LPF
        qw, qh = max(2, (x1 - x0) // LPF), max(2, (y1 - y0) // LPF)
        xx, yy = np.meshgrid(np.arange(qw, dtype=np.float32),
                             np.arange(qh, dtype=np.float32))
        rr = r / LPF
        cx, cy = qw / 2.0, qh / 2.0
        qx = np.abs(xx - cx) - (cx - rr)
        qy = np.abs(yy - cy) - (cy - rr)
        sdf = (np.hypot(np.maximum(qx, 0), np.maximum(qy, 0))
               + np.minimum(np.maximum(qx, qy), 0) - rr)
        gy, gx = np.gradient(sdf)
        n = np.maximum(np.hypot(gx, gy), 1e-6)
        d = -sdf
        alpha = np.clip((d + 0.6) / 1.2, 0.0, 1.0).astype(np.float32)
        t = np.clip(1.0 - d / BOX_BAND, 0.0, 1.0)
        mag = BOX_AMP * t * t
        sx = np.rint(qx0 + xx + gx / n * mag).astype(np.int32)
        sy = np.rint(qy0 + yy + gy / n * mag).astype(np.int32)
        np.clip(sx, 0, w // LPF - 1, out=sx)
        np.clip(sy, 0, h // LPF - 1, out=sy)
        # 边缘→中心用 smoothstep 过渡，二值硬切会看到一圈割裂
        weight = np.clip(d / BOX_BAND, 0.0, 1.0).astype(np.float32)
        weight = (weight * weight * (3.0 - 2.0 * weight)).astype(np.float32)
        out.append((qx0, qy0, qw, qh, alpha, weight, sx, sy))
    return tuple(out)


def _box_union(w: int, h: int, ow: int, oh: int, shapes: tuple[Box, ...]) -> Image.Image:
    """目标分辨率下的圆角联合遮罩，4x 超采样后缩小，边界平滑。"""
    ss = 4
    fx, fy = ow / w, oh / h
    m = Image.new("L", (ow * ss, oh * ss), 0)
    d = ImageDraw.Draw(m)
    for x0, y0, x1, y1, r in shapes:
        if x1 <= x0 or y1 <= y0:
            continue
        d.rounded_rectangle((x0 * fx * ss, y0 * fy * ss,
                             x1 * fx * ss, y1 * fy * ss),
                            radius=r * min(fx, fy) * ss, fill=255)
    return m.resize((ow, oh), Image.Resampling.LANCZOS)


@dataclass(frozen=True)
class Geometry:
    """一套尺寸下的全部贴图。不可变：改形状请用 `with_shapes()`。

    `version` 每次变更 +1，GPU 侧靠它判断要不要重建坐标纹理
    （对应旧代码里那个模块级的 `SHAPES_VERSION`）。
    """

    width: int
    height: int
    version: int = 0
    slabs: tuple[Box, ...] = ()
    mask_hard: Image.Image | None = None
    warp_x: np.ndarray | None = None
    warp_y: np.ndarray | None = None
    shapes: tuple[Box, ...] = ()
    overlay: Image.Image | None = None
    overlay_half: Image.Image | None = None
    plate: bool = False          # 当前 overlay 有没有气泡底板（空态为 False）
    box_maps: tuple[tuple, ...] = ()
    box_union_half: Image.Image | None = None
    mini: bool = False           # 小悬浮窗布局：两条胶囊、没有消息区和输入栏
    _mic_pos: tuple[int, int] = field(default=(0, 0), repr=False)

    # ---- 构造 ----

    @classmethod
    def for_size(cls, w: int, h: int, version: int = 0, mini: bool = False,
                 btns=None) -> "Geometry":
        shapes = shapes_for(w, h, mini)
        slabs = slabs_for(w, h, mini, btns)
        mask = _rounded_mask(w, h, slabs)
        # color-key 透明不能用半透明边缘：半透明像素会和 KEY 混合成黑边，
        # 所以遮罩二值硬切。
        mask_hard = mask.point(lambda v: 255 if v >= 128 else 0)
        warp_x, warp_y = _warp_maps(w, h)
        base = cls(width=w, height=h, version=version,
                   slabs=slabs, mask_hard=mask_hard,
                   warp_x=warp_x, warp_y=warp_y, mini=mini,
                   _mic_pos=(MIC_MARGIN[0], h - MIC_MARGIN[1]))
        return base.with_shapes(shapes, version=version, plate=False)

    def with_shapes(self, shapes: Iterable[Box], version: int | None = None,
                    plate: bool = True) -> "Geometry":
        shapes = tuple(shapes)
        overlay = _overlay(self.width, self.height, shapes, plate=plate)
        hw, hh = max(1, self.width // 2), max(1, self.height // 2)
        # GPU 只按 (尺寸, version) 决定要不要重传纹理：形状没变、只多了底板时
        # 也得换 version，否则会一直显示空态那张 overlay。
        bump = version is None or plate != self.plate
        return replace(
            self,
            version=(self.version + 1) if bump else self.version,
            shapes=shapes,
            overlay=overlay,
            overlay_half=overlay.resize((hw, hh), Image.Resampling.BILINEAR),
            plate=plate,
            box_maps=_box_maps(shapes, self.width, self.height),
            box_union_half=_box_union(self.width, self.height, hw, hh, shapes),
        )

    # ---- 派生量 ----

    @property
    def mic_pos(self) -> tuple[int, int]:
        return self._mic_pos

    @property
    def input_shape(self) -> Box:
        return self.shapes[-2]

    @property
    def send_shape(self) -> Box:
        return self.shapes[-1]

    @property
    def half_size(self) -> tuple[int, int]:
        return max(1, self.width // 2), max(1, self.height // 2)

    @property
    def input_top(self) -> int:
        return self.height - 80

    def collapsed_frame(self, frame: Image.Image | None) -> Image.Image | None:
        """折叠态：只保留标题栏那一块玻璃，按 78px 重新贴圆角。

        直接裁上一帧会让底部变成硬切边（遮罩还是整窗高度），看起来像渲染坏了。
        """
        if frame is None:
            return None
        try:
            w, h = self.width, self.height
            crop = frame.convert("RGB").crop((0, 0, w, h))
            mask = Image.new("L", (w, h), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                (SLAB_OUT, SLAB_OUT, w - SLAB_OUT, SLAB_OUT + SLAB_TOP_H),
                radius=SLAB_RADIUS, fill=255)
            out = Image.new("RGB", (w, h), KEY)
            out.paste(crop, (0, 0), mask)
            return out
        except Exception:
            return None


def collapsed_height() -> int:
    return 2 * SLAB_OUT + SLAB_TOP_H


__all__ = [
    "AMP", "BAND", "BAR_FRAC", "BAR_THICK", "BOX_AMP", "BOX_BAND", "Box",
    "CORNER_R", "DEFAULT_H", "DEFAULT_W", "Geometry", "KEY", "LPF",
    "INPUT_STRIP_H", "MESSAGE_SLOTS", "MSG_BOTTOM_MARGIN", "MSG_TOP", "msg_slots", "MIC_MARGIN", "MIC_SIZE", "MINI_GAP", "MINI_H", "MINI_ROW_H",
    "MINI_W", "MIN_H", "MIN_W", "PAD", "PLATE_ALPHA",
    "SLAB_RADIUS", "chat_layout", "collapsed_height", "mini_slabs",
    "set_plate_alpha", "set_plate_color", "shapes_for", "slabs_for",
]
