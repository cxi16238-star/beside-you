"""glass_static.py — 不吃性能的底板：静态磨砂（frost）与纯色（solid）。

`glass_cpu.py` / `glass_gpu.py` 每帧都要抓一次屏、再模糊、再折射；好看，但
**代价是每秒 30~60 次抓屏**。低配机、高分屏、4K 缩放的机器上，这笔账很容易
超过一帧预算，用户看到的就是「窗口一开，鼠标就开始飘」。

这里给第二种做法：**不抓屏，只画一张**。

- `frost`：一张预生成的冷色磨砂底板（对角渐变 + 两团极淡的光晕 + 细噪点 +
  每块玻璃 1px 的亮边），看起来仍像玻璃，但和桌面内容无关；
- `solid`：纯色底板，远程桌面 / 录屏下最稳（任何捕获方式都看得见）。

两者的共同点：**只在尺寸或形状变化时重画一张**，其余时间一帧都不用算。
CPU 占用从「一直有」降到「换尺寸的那一下」。这也是设置页里
「静态磨砂 —— 不吃性能」那一档的实现。

和另外两条渲染路径共用 `glass_capture.finish` / `paste_mic`：
圆角遮罩、麦克风图标只有一份，改一次三边都跟着变。
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from glass_capture import finish, paste_mic
from glass_geometry import SLAB_RADIUS, Geometry

# 纯色底板：和 glass_capture.SOLID_RGB 同一个色（"玻璃后面是暗背景"那种感觉）。
SOLID_RGB = (18, 22, 30)

# 磨砂底板的四个色：上浅下深，加两团很淡的光。数值都是按 8bit sRGB 调的，
# 整张图的亮度落在 0.12~0.18，白字压上去对比度足够（和 CPU 玻璃后面的暗桌面接近）。
FROST_TOP = np.array([36, 46, 63], dtype=np.float32)      # #242E3F
FROST_BOTTOM = np.array([13, 18, 26], dtype=np.float32)   # #0D121A
FROST_BLUE = np.array([24, 44, 72], dtype=np.float32)     # 左上：偏冷蓝
FROST_TEAL = np.array([16, 48, 48], dtype=np.float32)     # 右下：偏青
FROST_SHEEN = np.array([10, 12, 16], dtype=np.float32)    # 顶部高光

RIM_ALPHA = 22          # 玻璃边缘那圈 1px 亮线的强度
NOISE_SIGMA = 1.1       # 细噪点：只为压住渐变的色带，别让人看出颗粒


def _glow(u, v, cx, cy, sx, sy, color):
    """一团高斯光晕（`u/v` 是 0~1 的归一化坐标）。"""
    g = np.exp(-(((u - cx) / sx) ** 2 + ((v - cy) / sy) ** 2))
    return g[..., None] * color


def frost_base(w: int, h: int) -> Image.Image:
    """预生成一张磨砂底板（只在换尺寸时跑一次，1/4 分辨率算完再放大）。

    为什么不在全分辨率上算：这块最后是一个大尺度、低对比的渐变，1/4 分辨率
    放大后看不出差别；全分辨率跑一遍网格运算要几十毫秒，四分之一是它的 1/16。
    """
    qw, qh = max(2, w // 4), max(2, h // 4)
    yy, xx = np.mgrid[0:qh, 0:qw].astype(np.float32)
    u = (xx + 0.5) / qw
    v = (yy + 0.5) / qh

    # 主渐变：竖向下沉为主，掺一点横向，避免看着像纯色条
    t = np.clip(0.82 * v + 0.18 * u, 0.0, 1.0)[..., None]
    arr = FROST_TOP * (1.0 - t) + FROST_BOTTOM * t

    arr = arr + _glow(u, v, 0.12, -0.08, 0.42, 0.36, FROST_BLUE)
    arr = arr + _glow(u, v, 0.92, 1.02, 0.38, 0.42, FROST_TEAL)
    # 顶部一道很淡的横向高光：光从上面来，玻璃才不像一块塑料
    arr = arr + np.clip((0.10 - v) / 0.10, 0.0, 1.0)[..., None] * FROST_SHEEN

    # 固定种子：同一台机器每次生成的图案一样，截图对比时不会"莫名其妙变了"
    arr = arr + np.random.default_rng(7).normal(0.0, NOISE_SIGMA, (qh, qw, 1))

    small = Image.fromarray(np.clip(arr, 0.0, 255.0).astype(np.uint8))
    return small.resize((w, h), Image.Resampling.BILINEAR)


def _rim(geo: Geometry) -> Image.Image:
    """每块玻璃边缘 1px 的白色亮线（透明度很低）。

    这是"这是一块玻璃"最便宜的表达：不用抓背景、不用模糊，只是描一圈。
    只在 slab 内部，圆角外面会被 `finish()` 的遮罩裁掉。
    """
    layer = Image.new("RGBA", (geo.width, geo.height), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x0, y0, x1, y1 in geo.slabs:
        if x1 > x0 and y1 > y0:
            d.rounded_rectangle((x0, y0, x1, y1), radius=SLAB_RADIUS,
                                outline=(255, 255, 255, RIM_ALPHA), width=1)
    return layer


def render_plate(geo: Geometry, style: str = "frost") -> Image.Image:
    """出一张完整的窗口底板（已经贴好圆角遮罩和麦克风图标）。"""
    if style == "solid":
        base = Image.new("RGB", (geo.width, geo.height), SOLID_RGB)
    else:
        base = frost_base(geo.width, geo.height)

    panel = base.convert("RGBA")
    # 气泡底板/染色和另一条路径用同一份 overlay：文字对比度不能因为换了样式就变差
    if geo.overlay is not None:
        panel = Image.alpha_composite(panel, geo.overlay)
    panel = Image.alpha_composite(panel, _rim(geo))
    return paste_mic(geo, finish(geo, panel.convert("RGB")))


class StaticRenderer:
    """和 `CpuRenderer` / `GpuRenderer` 同形，但**不碰屏幕**。

    `window.py` 只在换尺寸/换形状时问它要一帧（`frame_for`），平时一次都不调用 ——
    静态样式下根本不起渲染线程，所以这里也不实现 `render()` 的逐帧语义。
    """

    broken = False

    def __init__(self, geo: Geometry, style: str = "frost"):
        self.geo = geo
        self.style = style if style in ("frost", "solid") else "frost"
        self._key = None
        self._frame: Image.Image | None = None

    # ---- 生命周期（和另外两个渲染器对齐） ----

    def set_geometry(self, geo: Geometry) -> None:
        self.geo = geo
        # 和 CPU/GPU 渲染器一致：换几何就作废旧帧（垫片换边后必须重画一张）
        self.invalidate()

    def invalidate(self) -> None:
        self._key = None
        self._frame = None

    def close(self) -> None:
        self.invalidate()

    # ---- 取帧 ----

    @staticmethod
    def _key_of(geo: Geometry, style: str):
        """缓存键必须带 `shapes`、`plate` 和 **`slabs`**。

        只按 `version` 判会串味：`Geometry.for_size()` 每次都从 0 起算，
        「展开折叠」重建出来的同一尺寸、不同气泡，version 会撞在一起，
        于是拿到的是上一套气泡的底板（文字还在，底板却错位）。

        `slabs` 也必须进键：按钮玻璃垫换边（拖窗跨过屏幕中线）时宽高和气泡
        都不变，只有垫片的 x 坐标变了 —— 不带进键，静态样式就永远返回
        "垫片还在旧位置"的缓存帧（实报：纯色/磨砂下垫片不跟着按钮走）。
        """
        return (geo.width, geo.height, geo.shapes, geo.plate, style, geo.slabs)

    def frame_for(self, geo: Geometry | None = None) -> Image.Image:
        geo = geo or self.geo
        key = self._key_of(geo, self.style)
        if key != self._key or self._frame is None:
            self._frame = render_plate(geo, self.style)
            self._key = key
        return self._frame

    def render(self, source=None, sct=None, bbox=None):
        """兼容逐帧接口：静态样式下永远返回同一张（正常路径不会调到这里）。"""
        return self.frame_for()


__all__ = ["StaticRenderer", "frost_base", "render_plate", "SOLID_RGB"]
