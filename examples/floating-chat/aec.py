#!/usr/bin/env python3
"""aec.py — 把"电脑放出来的声音"从麦克风里减掉（回声消除）。

## 为什么需要它

陪看时音箱在放视频的声音，麦克风会一起听见。对转写来说那就是"用户说了视频里的台词"，
模型会以为你在跟它复述剧情。TTS 念台词时更糟：麦克风听见 AI 自己说的话 → 转成文字 →
模型回答自己 → 自激。

## 为什么自己写

`speexdsp` / `webrtc-audio-processing` 这两个正经的 AEC 库在这台机器上装不上
（没有 C 编译器、也没有现成的 wheel）。所以这里用 numpy 写一个频域自适应滤波器
（FDAF，overlap-save + 归一化步长），16k 单声道下每帧一次 FFT，CPU 可以忽略。

## 它做什么

    参考信号 ref（回环抓到的"电脑在放什么"）──▶ 自适应滤波 ──▶ 估计的回声
    麦克风 mic（你的声音 + 回声）  −  估计的回声  =  只剩你的声音

滤波器自己跟着房间响应走（你挪一下音箱、换个音量它都会重新收敛），
所以不需要预先测量什么。

## 它的边界（必须说清楚）

- **消不掉的是"跟你声音同时发生、且和参考不相关"的东西** —— 那本来就不是回声。
- 参考信号必须是"音箱里真正放出来的声音"（回环/立体声混音）。抓错了（比如抓成立体声混音
  里含麦克风的那种）会把你的声音也减掉。
- 滤波器长度 `taps` 决定了能覆盖多长的混响尾巴。默认 8192 点 ≈ 512ms，够一般桌面音箱。
"""

import numpy as np


class FdafAec:
    """频域自适应回声消除（overlap-save，功率归一化 NLMS）。

    用法：每来一帧（长度 = frame）调用一次 `process(mic_frame, ref_frame)`，
    返回去掉回声后的这一帧。两路信号必须**同采样率、同声道数、时间上对齐**。
    """

    def __init__(self, frame=512, taps=8192, mu=0.35, power_decay=0.9, eps=1e-8,
                 dt_ratio=2.0):
        self.N = int(frame)
        self.M = int(taps)
        # overlap-save：FFT 长度至少是 N + M
        self.L = 1 << int(np.ceil(np.log2(self.N + self.M)))
        self.W = np.zeros(self.L // 2 + 1, dtype=np.complex128)
        self.P = np.full(self.L // 2 + 1, eps, dtype=np.float64)  # 每 bin 的功率（归一化用）
        self.x_buf = np.zeros(self.L, dtype=np.float64)           # 参考信号历史
        self.mu = float(mu)
        self.decay = float(power_decay)
        self.eps = eps
        # 双讲保护：麦克风峰值超过"参考信号近期峰值 × 这个倍数"就判定人在说话，冻住滤波器。
        # 0 或 None = 不保护（回声很干净、或你从不跟视频同时说话时可以关掉）。
        self.dt_ratio = float(dt_ratio or 0) or None
        self.ref_peak = 0.0
        self.peak_decay = 0.995      # 参考峰值的衰减：约 6 秒的滑动窗口
        self.frozen = 0

    def reset(self):
        self.W[:] = 0
        self.P[:] = self.eps
        self.x_buf[:] = 0

    def process(self, mic, ref):
        """消掉一帧。mic / ref 都是长度 N 的 float 数组，返回去回声后的 mic。"""
        n = self.N
        mic = np.asarray(mic, dtype=np.float64)
        ref = np.asarray(ref, dtype=np.float64)
        if len(ref) < n:
            ref = np.pad(ref, (0, n - len(ref)))
        if len(mic) < n:
            mic = np.pad(mic, (0, n - len(mic)))

        # 参考信号滑进历史缓冲（最新的 n 个在末尾）
        self.x_buf[:-n] = self.x_buf[n:]
        self.x_buf[-n:] = ref[:n]

        X = np.fft.rfft(self.x_buf)
        echo = np.fft.irfft(self.W * X)[-n:]        # overlap-save：取末尾 n 个
        err = mic[:n] - echo

        # ---- 双讲保护（Geigel 判据）：你在说话时，麦克风里"不是回声"的那部分会把
        # 滤波器带跑，必须冻住。
        #
        # **不能拿"回声估计"当比较对象**：滤波器一开始是 0、估计也是 0，
        # 于是永远判定成"你在说话" → 冻死 → 永远不收敛（第一版就是这个 bug）。
        # 要比就和**参考信号**比：它不依赖滤波器当前状态。
        peak_mic = float(np.max(np.abs(mic[:n]))) if n else 0.0
        peak_ref = float(np.max(np.abs(ref[:n]))) if n else 0.0
        self.ref_peak = max(self.ref_peak * self.peak_decay, peak_ref)
        if self.dt_ratio and self.ref_peak > 1e-6 and peak_mic > self.dt_ratio * self.ref_peak:
            self.frozen += 1
            return err

        # ---- 更新：功率归一化的频域 NLMS
        Xp = (X.real ** 2 + X.imag ** 2)
        self.P = self.decay * self.P + (1 - self.decay) * Xp
        # 误差也要补零到 L 再变换，才和 overlap-save 的长度对齐
        E = np.fft.rfft(np.concatenate([np.zeros(self.L - n), err]))
        step = self.mu / (self.P + self.eps)
        self.W += step * np.conj(X) * E
        return err

    def erle_db(self, mic_before, err_after):
        """回声衰减了多少 dB（越大越好；>10dB 就明显，>20dB 很好）"""
        a = float(np.mean(np.asarray(mic_before, dtype=np.float64) ** 2))
        b = float(np.mean(np.asarray(err_after, dtype=np.float64) ** 2))
        if b <= 1e-12:
            return float("inf") if a > 0 else 0.0
        return 10.0 * np.log10(max(a, 1e-12) / b)


def find_loopback_device(candidates=None):
    """找"电脑在放什么"那条回环通道（sounddevice 版，老的退路）。

    优先"扬声器/喇叭/Speakers/Loopback"，其次"立体声混音/Stereo Mix"。
    **不要**用会含麦克风的混音通道 —— 那会把你的声音也一起减掉。

    ⚠️ PortAudio 官方**看不到** WASAPI loopback，所以这里能找到的多半是
    "立体声混音"之类。优先用下面的 `LoopbackRef`（pyaudiowpatch）。
    虚拟声卡（Steam / VB-Cable / VoiceMeeter…）一律跳过：它们不是"扬声器实际
    放出来的声音"，打开后当参考会把用户自己的声音减掉。
    """
    import sounddevice as sd

    prefer = candidates or ["立体声混音", "stereo mix", "what u hear", "loopback",
                            "扬声器", "喇叭", "speaker"]
    BLOCK = ("steam", "virtual", "vb-audio", "voicemeeter", "cable", "wave out")
    best = None
    for i, d in enumerate(sd.query_devices()):
        if d.get("max_input_channels", 0) <= 0:
            continue
        name = (d.get("name") or "").lower()
        if any(b in name for b in BLOCK):
            continue
        for rank, key in enumerate(prefer):
            if key.lower() in name:
                if best is None or rank < best[0]:
                    best = (rank, i, d.get("name"))
                break
    return (best[1], best[2]) if best else (None, None)


class LoopbackRef:
    """用 pyaudiowpatch 抓「电脑正在放什么」（WASAPI loopback），当 AEC 的参考信号。

    为什么不用 sounddevice：PortAudio 官方不暴露 WASAPI loopback，
    `sd.query_devices()` 里只有真实输入设备。老代码靠 "speaker" 关键字撞上了
    "Steam Streaming Speakers Wave" 这种虚拟输入 —— 打不开（WDM-KS 不支持阻塞 API），
    就算打开了，它装的也不是扬声器实际输出，反而可能把用户自己的声音当参考减掉。

    pyaudiowpatch（PyAudioWPatch）是打了补丁的 PortAudio，能列出 `... [Loopback]`。
    这里开一条后台回调流，把声音降成 16k 单声道丢进队列，主循环按 512 样本取。
    取不到的时候补零：宁可这一拍少消一点回声，也不能卡住麦克风。
    """

    def __init__(self, index=None, dst_rate=16000, chunk=512):
        import queue

        import pyaudiowpatch as pa

        self._np = np
        self.dst_rate = int(dst_rate)
        self.chunk = int(chunk)
        self.p = pa.PyAudio()
        self.q = queue.Queue(maxsize=64)
        self._pend = np.zeros(0, dtype=np.float32)

        info = None
        if index is not None:
            info = self.p.get_device_info_by_index(int(index))
        else:
            wasapi = self.p.get_host_api_info_by_type(pa.paWASAPI)
            out = self.p.get_device_info_by_index(wasapi["defaultOutputDevice"])
            out_name = str(out.get("name") or "")
            for lb in self.p.get_loopback_device_info_generator():
                if out_name and out_name in str(lb.get("name") or ""):
                    info = lb
                    break
            if info is None:
                info = next(self.p.get_loopback_device_info_generator(), None)
        if info is None:
            raise RuntimeError("没有可用的 loopback 设备")

        self.index = int(info["index"])
        self.name = str(info.get("name") or "")
        self.rate = int(round(float(info["defaultSampleRate"])))
        self.ch = max(1, int(info.get("maxInputChannels") or 1))
        self.stream = self.p.open(
            format=pa.paFloat32, channels=self.ch, rate=self.rate,
            input=True, input_device_index=self.index,
            frames_per_buffer=self.chunk, stream_callback=self._cb,
        )
        self.stream.start_stream()

    def _cb(self, in_data, frame_count, time_info, status):
        x = self._np.frombuffer(in_data, dtype=self._np.float32)
        if self.ch > 1:
            x = x.reshape(-1, self.ch).mean(axis=1)
        if self.rate != self.dst_rate and len(x) > 1:
            n_out = max(1, int(round(len(x) * self.dst_rate / self.rate)))
            x = self._np.interp(self._np.linspace(0, len(x) - 1, n_out),
                                self._np.arange(len(x)), x).astype(self._np.float32)
        try:
            self.q.put_nowait(x)
        except Exception:
            pass                                  # 队列满了就丢：参考信号晚到没用
        return (None, 0)                          # paContinue

    def read(self, n=None):
        n = int(n or self.chunk)
        out = self._pend
        while len(out) < n:
            try:
                out = np.concatenate([out, self.q.get(timeout=0.02)])
            except Exception:
                break
        if len(out) < n:
            out = np.concatenate([out, np.zeros(n - len(out), dtype=np.float32)])
        self._pend = out[n:]
        return out[:n].copy()

    def close(self):
        try:
            self.stream.stop_stream()
            self.stream.close()
        except Exception:
            pass
        try:
            self.p.terminate()
        except Exception:
            pass
