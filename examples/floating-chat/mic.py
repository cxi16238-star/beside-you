#!/usr/bin/env python3
"""mic.py — 麦克风 → 文字 → 统一文本流（chat.jsonl）。

悬浮窗那个 🎤 按钮开的就是这个进程：点开就开始听，你说完一句，它自动转成文字
**写进聊天流**（和你在框里打字的那条路一模一样）。写进去之后：

  · 悬浮窗 / 浏览器页面下一拍就显示出来（它们读同一个文件）
  · 阻塞中的 `cue` 立刻收到这条 → INTERRUPT → 模型马上接话

## 为什么默认**自己加载一份模型**（--engine local）

视频转写和麦克风是两件事，谁也不该等谁。实测（本机 i9-12900HX）：

  · 一个 int8 paraformer 实例 ≈ **284 MB** 工作集，加载 1.8–2.6 s
  · 同一个实例并发转写几乎不排队（45s 长音频转写时，3s 短句只要 0.14 s）

所以"开两个进程"完全开得起。而且现有服务把解码写在 `async def` 里（CPU 密集的活
堵在事件循环上），视频在转的时候麦克风会跟着排队 —— 自带模型就彻底不相干。

`--engine http` 可以改回共用 8000 端口那个服务（省 284MB，但要等长音频转完）。

## 一个必须挡住的坑：它不能听见自己

陪看时 AI 会用 TTS 念台词，声音从音箱出来 → 麦克风听见 → 转写成"用户说的话"
→ 模型又回一句 → 无限自激。所以每句话转写前都查一次 `quiet-until.json`
（`say`/`cue` 念台词前会占住这个窗口），窗口内直接丢掉这段音频。

## 用法

    python mic.py                      自动选模型（装了 SenseVoice 就用它），默认麦克风
    python mic.py --engine sense       强制 SenseVoice（中英混说/噪声/标点更好）
    python mic.py --engine local       强制 paraformer（省内存，退路）
    python mic.py --engine http        共用 ASR 服务（省内存）
    python mic.py --list-devices       看看有哪些输入设备
    python mic.py --device 2           指定麦克风
    python mic.py --pad 0.25           每段前面补多少秒（默认 0.25，补掉 VAD 的滞后）
    python mic.py --language auto      中英混说很重时可以试 auto
    python mic.py --from-file a.wav    拿文件当"麦克风"（不用真说话就能测）

采样是按**设备原生采样率**打开的，再自己用 soxr（没有就 scipy，再没有就 numpy 的
窗函数 sinc）降到 16k —— 直接跟 WASAPI 要 16000 会让驱动替我们转，质量不可控。

依赖：`pip install sounddevice numpy`；重采样建议再装 `soxr`（10 秒装完，质量明显好于线性）。
"""

import argparse
import json
import os
import sys
import time
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import numpy as np                            # 模块级：环形缓冲和回声消除都要用
except ImportError:
    sys.stderr.write("缺 numpy：pip install numpy\n")
    raise SystemExit(2)

# 回声消除：把电脑放出来的声音从麦克风里减掉。
# **不是硬依赖**：打包漏了 aec.py 时（issue #36：0.0.2–0.1.3 的 see-now 包都没带）
# 麦克风仍要能起来，只是不做回声消除 —— 而模块级 import 失败会让整个进程当场退出，
# 悬浮窗那边 stderr 又被丢进 DEVNULL，用户只看到"录音中"三个字。
try:
    from aec import FdafAec, find_loopback_device, LoopbackRef
except ImportError:
    FdafAec = None
    find_loopback_device = None
    LoopbackRef = None

# ---------------------------------------------------------------- 与悬浮窗共享的那份流


def cache_dir():
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return d
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return os.path.join(local, "dsh-video-storyboard", "cache")
    return os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                        "dsh-video-storyboard")


CHAT_FILE = os.path.join(cache_dir(), "chat.jsonl")

# 实时状态：窗口每 250ms 读一次，拿它画麦克风按钮外面那一圈
# （用户在说话时圈会跟着音量涨大 —— 这样不用等转写出来就知道"它听见了"）
STATUS_FILE = os.path.join(os.path.dirname(CHAT_FILE), "mic-status.json")
LOG_FILE = os.path.join(os.path.dirname(CHAT_FILE), "mic.log")
# 正在说的这半句（实时转写预览）：窗口拿去弹输入框，边说你边看见字
PARTIAL_FILE = os.path.join(os.path.dirname(CHAT_FILE), "mic-partial.json")


def write_partial(text):
    """写"当前正在说的这句"的中间结果。空字符串 = 说完了/没了，窗口据此收起输入框。"""
    text = str(text or "").strip()
    # 只有标点的"预览"没有意义：短缓冲（0.5 秒）经常只转出一个"。"，
    # 弹出来就是一个空框加个句号，很难看 —— 当成空。
    if text and not any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in text):
        text = ""
    try:
        os.makedirs(os.path.dirname(PARTIAL_FILE), exist_ok=True)
        with open(PARTIAL_FILE, "w", encoding="utf-8") as f:
            json.dump({"at": int(time.time() * 1000), "text": str(text or "")},
                      f, ensure_ascii=False)
    except Exception:
        pass
_status_at = 0.0
_note_until = 0.0
_noise_floor = 0.0
_transcribe_until = 0.0


def mic_level(rms, threshold):
    """把 RMS 变成 0..1 的"看起来像在说话"的亮度。

    直接 `rms*14` 不行：环境底噪就有 0.06 的话，那一圈永远是满的、等于没信息。
    这里跟一个**慢速噪声地板**（只往上跟得很慢），只画"高出地板"的那部分。
    """
    global _noise_floor
    rms = float(rms)
    if _noise_floor <= 0:
        # 别拿"第一帧"当地板：点开麦克风时第一帧很可能就是人声，
        # 那会把地板抬到人声高度，之后你说什么都亮不起来。
        _noise_floor = max(0.004, min(rms, 0.02))
    # 地板慢慢跟：安静时向下漂、接近人声时几乎不动
    if rms < _noise_floor * 1.5:
        _noise_floor = _noise_floor * 0.995 + rms * 0.005
    elif rms < _noise_floor * 3.0:
        _noise_floor = _noise_floor * 0.999 + rms * 0.001
    span = max(0.02, _noise_floor * 5.0)
    return max(0.0, min(1.0, (rms - _noise_floor * 1.6) / span))


def write_status(state="listening", level=0.0, note=""):
    """写一行实时状态（限流 ~8 次/秒）。写失败就算了，窗口那头会当"没在录"。

    `note`（"太小声"/"没听清"）会**压住音量更新 1.2 秒**，否则下一帧就把它冲掉，
    窗口 250ms 轮询一次根本看不到。
    """
    global _status_at, _note_until
    now = time.time()
    if note:
        _note_until = now + 1.2
    elif now < _note_until:
        return
    if not note and now - _status_at < 0.12:
        return
    _status_at = now
    try:
        os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump({"at": int(now * 1000), "state": state,
                       "level": round(float(level), 3), "note": note}, f, ensure_ascii=False)
    except Exception:
        pass

def watch_out_dir():
    """和 `bin/watch.mjs` 用**同一套默认值**。

    `WATCH_OUT` 优先，否则 `$DSH_HOME/watch/out`（`DSH_HOME` 默认 `~/.dsh`）。
    以前这里写死了作者的工作区路径：别人装上永远找不到那个文件，
    于是"静音窗口"形同不存在 —— 麦克风会把 TTS 自己的声音当用户说话（无限自激）。
    """
    explicit = os.environ.get("WATCH_OUT") or os.environ.get("DSH_WATCH_OUT")
    if explicit:
        return explicit
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "watch", "out")


# TTS 占用窗口：say / cue 念台词前会写这个文件，窗口内的音频一律丢弃
QUIET_FILE = os.environ.get("DSH_QUIET_FILE") or os.path.join(watch_out_dir(), "quiet-until.json")


def append_user(text):
    os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def tts_busy():
    """AI 正在念（或刚念完）：这时麦克风听到的多半是它自己的声音"""
    try:
        with open(QUIET_FILE, "r", encoding="utf-8") as f:
            return time.time() * 1000 < float(json.load(f).get("until") or 0)
    except Exception:
        return False


# ---------------------------------------------------------------- 引擎


class LocalEngine:
    """自带一份模型：和视频那条路彻底不相干

    两种模型，用 `--engine sense|local` 选（`auto` 看目录里有没有）：

      · `sense`      → **SenseVoice-Small**：中英日韩粤混说、噪声/远场下明显更稳，
                       自带 ITN（"二零二五" → "2025"）和标点。中文 CER 比 paraformer 低 1–2 个点，
                       CPU 上速度差不多。
      · `paraformer` → 老的 paraformer-zh int8（省一点内存，也留作退路）

    两者都是 sherpa-onnx 的离线识别器，接口一样，只差一次工厂调用 ——
    换模型不动上面录音/VAD 那条线。
    """

    def __init__(self, models_dir, punct=True, kind="paraformer", language="zh"):
        import sherpa_onnx

        t0 = time.time()
        model = os.path.join(models_dir, "model.int8.onnx")
        if not os.path.exists(model):
            model = os.path.join(models_dir, "model.onnx")
        tokens = os.path.join(models_dir, "tokens.txt")
        self.kind = kind
        if kind == "sense":
            self.rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=model,
                tokens=tokens,
                num_threads=4,
                language=language,     # zh / en / ja / ko / yue / auto
                use_itn=True,
            )
        else:
            self.rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
                paraformer=model,
                tokens=tokens,
                num_threads=4,
                sample_rate=16000,
            )
        self.punct = None
        # SenseVoice 自带标点 + ITN，再叠一层 ct-transformer 会重复加标点
        if punct and kind != "sense":
            p = os.path.join(models_dir, "punct", "model.onnx")
            v = os.path.join(models_dir, "punct", "tokens.json")
            if os.path.exists(p) and os.path.exists(v):
                try:
                    self.punct = sherpa_onnx.OfflinePunctuation(
                        sherpa_onnx.OfflinePunctuationConfig(
                            model=sherpa_onnx.OfflinePunctuationModelConfig(ct_transformer=p)
                        )
                    )
                except Exception as exc:
                    self._log(f"标点模型没起来（{exc}），照常出字")
        self._log(f"本地模型就绪 {time.time()-t0:.1f}s（{kind} @ {models_dir}）")

    def _log(self, msg):
        print(msg, file=sys.stderr, flush=True)

    def __call__(self, samples):
        import sherpa_onnx  # noqa: F401  (已加载，只为保持显式)
        s = self.rec.create_stream()
        s.accept_waveform(16000, samples)
        self.rec.decode_stream(s)
        text = (s.result.text or "").strip()
        if text and self.punct:
            try:
                text = self.punct.add_punctuation(text).strip()
            except Exception:
                pass
        return text


class HttpEngine:
    """共用 8000 端口那个服务。省内存，但视频在转长音频时要排队"""

    def __init__(self, url="http://127.0.0.1:8000"):
        import requests

        self.url = url.rstrip("/")
        self.s = requests.Session()
        print(f"共用 ASR 服务 {self.url}", file=sys.stderr, flush=True)

    def __call__(self, samples):
        import io

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            pcm = (samples * 32767).astype("<i2")
            w.writeframes(pcm.tobytes())
        r = self.s.post(
            f"{self.url}/v1/audio/transcriptions",
            files={"file": ("a.wav", buf.getvalue(), "audio/wav")},
            data={"response_format": "verbose_json", "language": "zh"},
            timeout=120,
        )
        r.raise_for_status()
        return (r.json().get("text") or "").strip()


# ---------------------------------------------------------------- 录音


def make_vad(models_dir):
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = os.path.join(models_dir, "silero_vad.onnx")
    cfg.silero_vad.min_silence_duration = 0.75
    cfg.silero_vad.min_speech_duration = 0.2
    cfg.sample_rate = 16000
    # 0.75 秒静音才算"一句说完"（原来 0.45）：中文说话中间停顿多，
    # 0.45 会把"漏了……是否"这种切成两段，看起来像漏字。
    # 代价是说完到出字慢 0.3 秒 —— 比把句子切碎了好。
    # 环形缓冲 30 秒：一句话说超 30 秒会被切成两段（正常说话不会）
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)


def open_resampler(src_rate, dst_rate=16000):
    """把设备原生采样率降到 16k 的**流式**重采样器。

    为什么不在 `sd.InputStream(samplerate=16000)` 里直接要 16k：Windows 的
    WASAPI 共享模式会让驱动替你做转换，质量不可控 —— 不少驱动就是线性插值，
    混叠直接进模型。自己用 soxr（高质量多相滤波器）来做，至少知道发生了什么。

    soxr 没装就退回 scipy 的 `resample_poly`；再没有就线性插值（能跑，但会掉分）。
    返回 None 表示"设备本来就是 16k，不用转"。
    """
    if int(src_rate) == int(dst_rate):
        return None

    try:
        import soxr

        st = soxr.ResampleStream(int(src_rate), int(dst_rate), 1, dtype="float32", quality="HQ")
        backend = "soxr"

        def _soxr(x):
            return np.asarray(st.resample_chunk(np.asarray(x, dtype=np.float32), last=False),
                              dtype=np.float32)

        _soxr.backend = backend
        return _soxr
    except Exception:
        pass

    try:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(int(src_rate), int(dst_rate))
        up, down = int(dst_rate) // g, int(src_rate) // g

        def _poly(x):
            return np.asarray(resample_poly(np.asarray(x, dtype=np.float32), up, down),
                              dtype=np.float32)

        _poly.backend = "scipy"
        return _poly
    except Exception:
        pass

    def _sinc(x):
        """窗函数 sinc 插值：纯 numpy，32 抽头。

        比线性插值好得多（线性那个 4kHz 以上基本是混叠），
        也不需要额外装包 —— 窗口可能跑在别的解释器上，那里未必有 soxr/scipy。
        """
        x = np.asarray(x, dtype=np.float32)
        ratio = float(dst_rate) / float(src_rate)
        n_out = int(np.floor(len(x) * ratio))
        if n_out <= 0:
            return np.zeros(0, dtype=np.float32)
        H = 16
        t = np.arange(n_out, dtype=np.float64) / ratio
        i0 = np.floor(t).astype(np.int64)
        frac = t - i0
        win = np.hanning(2 * H + 1)
        acc = np.zeros(n_out, dtype=np.float64)
        wsum = np.zeros(n_out, dtype=np.float64)
        for k in range(-H, H + 1):
            idx = i0 + k
            h = np.sinc(k - frac) * win[k + H]
            ok = (idx >= 0) & (idx < len(x))
            acc[ok] += x[idx[ok]] * h[ok]
            wsum[ok] += h[ok]
        return (acc / np.maximum(wsum, 1e-9)).astype(np.float32)

    _sinc.backend = "sinc"
    return _sinc


class PreRoll:
    """给每段前面补一点「VAD 还没判成说话」的音频。

    silero 判"开始说话"通常晚 100–250ms，第一个字的声母（b/p/d/t…）往往就这么没了；
    sherpa 的 segment 自带一点留白，但对轻声起头的普通话不够。实测补 0.25s 之后
    "那个/就是/然后"这类起头词才稳定出得来。
    """

    def __init__(self, pad=0.25, seconds=3.0, sr=16000):
        self.sr = int(sr)
        self.pad = int(pad * self.sr)
        self.buf = np.zeros(int(seconds * self.sr), dtype=np.float32)
        self.n = 0

    def push(self, x):
        x = np.asarray(x, dtype=np.float32).reshape(-1)
        idx = np.arange(self.n, self.n + len(x)) % len(self.buf)
        self.buf[idx] = x
        self.n += len(x)

    def prepend(self, start, samples):
        if self.pad <= 0:
            return samples
        s = int(start) - self.pad
        if s < 0 or s < self.n - len(self.buf):
            return samples                      # 缓冲里还没攒够，补不了
        take = int(start) - s
        if take <= 0:
            return samples
        head = self.buf[(s + np.arange(take)) % len(self.buf)]
        return np.concatenate([head, np.asarray(samples, dtype=np.float32)])


def log(msg):
    """打日志：既进 stderr（手动跑时看得到），也落一份到 mic.log。

    窗口点 🎤 起的那个进程 stderr 是 DEVNULL —— 不留文件的话，"这句为什么没出来"
    永远查不到（只能看到 chat.jsonl 里少了一行）。
    """
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, file=sys.stderr, flush=True)
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1_000_000:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


class Ring:
    """环形缓冲：存原始麦克风（消回声**之前**的），用来判断"这段到底是不是回声"。

    为什么需要它：AEC 消完之后还剩多少，是"这句话是不是你自己的"最直接的证据 ——
    全是电脑声音的话，消完基本就没了；你自己说的话，消完还在。
    """

    def __init__(self, seconds=60, sr=16000):
        self.buf = np.zeros(int(seconds * sr), dtype=np.float32)
        self.n = 0                  # 累计写入的样本数（绝对下标）

    def push(self, x):
        x = np.asarray(x, dtype=np.float32)
        idx = np.arange(self.n, self.n + len(x)) % len(self.buf)
        self.buf[idx] = x
        self.n += len(x)

    def get(self, start, length):
        idx = (int(start) + np.arange(int(length))) % len(self.buf)
        return self.buf[idx]


def run(args):
    models_dir = args.models_dir or os.path.join("D:/asr-local", "models-sherpa")
    sense_dir = args.sense_dir or os.path.join("D:/asr-local", "models-sensevoice")
    engine_kind = args.engine
    if engine_kind == "auto":
        # 装了 SenseVoice 就用它，没装就还是 paraformer —— 不让人因为忘了加参数退回去
        engine_kind = "sense" if os.path.exists(os.path.join(sense_dir, "model.int8.onnx")) \
            else "local"
    if engine_kind == "http":
        engine = HttpEngine(args.url)
    else:
        d = sense_dir if engine_kind == "sense" else models_dir
        engine = LocalEngine(
            d,
            punct=not args.no_punct,
            kind="sense" if engine_kind == "sense" else "paraformer",
            language=args.language,
        )
    vad = make_vad(models_dir)                      # VAD 模型始终在 paraformer 目录里
    pre = PreRoll(pad=args.pad)

    def handle(samples, raw=None):
        dur = len(samples) / 16000
        if dur < args.min_sec:
            write_status("listening", 0, "太短")
            return
        # ---- 硬闸门：AEC 把这段基本消没了 = 它本来就是电脑放出来的声音
        # （实测：纯回声段消完只剩约 1/5，人声段基本不动）
        if raw is not None and args.echo_gate > 0:
            a = float(np.sqrt(np.mean(np.asarray(raw, dtype=np.float64) ** 2)))
            b = float(np.sqrt(np.mean(np.asarray(samples, dtype=np.float64) ** 2)))
            if a > 1e-9 and b / a < args.echo_gate:
                log(f"（{dur:.1f}s 丢掉：消完只剩 {b/a*100:.0f}%，是电脑的声音）")
                write_status("listening", 0, "像电脑的声音")
                return
        rms = float(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0.0
        if rms < args.threshold:
            write_status("listening", 0, "太小声")
            return                                  # 太安静：多半是环境噪声
        if tts_busy():
            log(f"（{dur:.1f}s 丢掉：AI 正在念，那是它自己的声音）")
            write_status("listening", 0, "我在念台词")
            return
        if dumping:
            # 查"漏字"用：把这一段的原始音频留成 wav，回头听就知道是切句切掉了，
            # 还是模型自己吞了。平时不写（目录里没 mic-record 这个文件就不存）。
            try:
                os.makedirs(dump_dir, exist_ok=True)
                p = os.path.join(dump_dir, f"seg-{int(time.time() * 1000)}-{dur:.1f}s.wav")
                with wave.open(p, "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(16000)
                    w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            except Exception as exc:
                log(f"存音频失败：{exc}")
        global _transcribe_until
        _transcribe_until = time.time() + 0.6
        write_status("transcribing", 0.0)
        t0 = time.time()
        try:
            text = engine(samples)
        except Exception as exc:
            log(f"转写失败：{exc}")
            return
        if not text:
            write_status("listening", 0, "没听清")
            return
        log(f"识别 {dur:.1f}s / {time.time()-t0:.2f}s：{text}")
        write_status("listening", 0.0, "")
        if args.dry_run:
            print(text, flush=True)
            return
        try:
            append_user(text)
            live["buf"] = np.zeros(0, dtype=np.float32)
            write_partial("")                       # 定稿已经进聊天流了，预览收起
        except Exception as exc:
            log(f"写不进聊天流：{exc}")

    # ---- 回声消除：拿"电脑在放什么"当参考，从麦克风里把它减掉
    aec = None
    lb = None
    if not args.no_aec:
        if FdafAec is None or LoopbackRef is None:
            log("缺 aec.py / pyaudiowpatch，回声消除关 —— 麦克风照常可用，但扬声器的声音会被一起收进来")
        else:
            try:
                lb = LoopbackRef(index=args.loopback)
                aec = FdafAec(frame=512, taps=args.taps, mu=0.35, dt_ratio=args.dt_ratio)
                log(f"回声消除开：参考设备 [{lb.index}] {lb.name}（loopback @ {lb.rate} Hz）")
            except Exception as exc:
                log(f"回环参考起不来（{exc}），回声消除关 —— 麦克风照常可用")
                aec = None
                lb = None
    ring = Ring()

    # 诊断开关：在 see-now 目录里放一个空文件 `mic-record`，每段音频都会存成 wav。
    # 排查"说话只出来一个字"时最有用 —— 能听出是切句切掉了还是模型吞了。
    dump_dir = os.path.join(os.path.dirname(CHAT_FILE), "segments")
    dumping = os.path.exists(os.path.join(os.path.dirname(CHAT_FILE), "mic-record"))

    # ---- 实时预览：边说你边看见字
    # 不靠 VAD 的"整句"（那要等 0.75s 静音才给），而是自己攒一个最多 8 秒的滚动
    # 缓冲，每 0.45 秒拿它转一次写进 mic-partial.json。窗口拿它弹输入框。
    live = {"buf": np.zeros(0, dtype=np.float32), "next": 0.0, "silent": 1.0}

    def live_tick(frame, lvl):
        """边攒边转：把"正在说的这半句"每 0.45 秒转一次，写进 mic-partial.json。

        只认音量（lvl），不认 VAD —— VAD 要等 0.75 秒静音才给你整句，那太晚了。
        """
        if lvl > 0.06:
            live["buf"] = np.concatenate([live["buf"], frame])[-16000 * 8:]
            live["silent"] = 0.0
        else:
            live["silent"] += len(frame) / 16000.0
            if live["silent"] > 0.9 and len(live["buf"]):
                live["buf"] = np.zeros(0, dtype=np.float32)
                write_partial("")                   # 说完了：让窗口收起输入框
        now = time.time()
        if len(live["buf"]) >= 16000 * 0.45 and now >= live["next"]:
            live["next"] = now + 0.45
            try:
                write_partial(engine(live["buf"][-16000 * 6:]))
            except Exception as exc:
                log(f"预览转写失败：{exc}")

    def feed(block, ref_block=None):
        """喂一帧：先消回声，再交给 VAD；消完剩多少用来挡纯回声"""
        frame = np.asarray(block, dtype=np.float32).reshape(-1)
        raw = None
        if aec is not None and ref_block is not None:
            raw = frame.copy()
            ring.push(raw)
            frame = aec.process(frame, np.asarray(ref_block, dtype=np.float32).reshape(-1))
        # 先记进 pre-roll 再喂 VAD：segment.start 是"喂进去之后"的时间轴
        pre.push(frame)
        rms = float(np.sqrt(np.mean(frame ** 2))) if len(frame) else 0.0
        lvl = mic_level(rms, args.threshold)
        state = "transcribing" if time.time() < _transcribe_until else ("speech" if lvl > 0.12 else "listening")
        write_status(state, lvl)
        live_tick(frame, lvl)
        vad.accept_waveform(frame.tolist())
        while not vad.empty():
            seg = vad.front
            samples = np.array(seg.samples, dtype=np.float32)
            # 补上前 0.25s：VAD 判"开始说话"是滞后的，不补就吃字
            samples = pre.prepend(seg.start, samples)
            handle(samples, ring.get(seg.start, len(seg.samples)) if raw is not None else None)
            vad.pop()

    if args.from_file:
        log(f"用文件当麦克风：{args.from_file}")

        def load(path):
            with wave.open(path, "rb") as w:
                rate = w.getframerate()
                p = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
            if rate != 16000:
                idx = np.linspace(0, len(p) - 1, int(len(p) * 16000 / rate)).astype(int)
                p = p[idx]
            return p / 32768.0

        pcm = load(args.from_file)
        ref_pcm = load(args.ref_file) if args.ref_file else (pcm if aec is not None else None)
        for i in range(0, len(pcm), 512):
            r = ref_pcm[i:i + 512] if ref_pcm is not None else None
            feed(pcm[i:i + 512], r)
        vad.flush()
        while not vad.empty():
            seg = vad.front
            samples = np.array(seg.samples, dtype=np.float32)
            handle(samples, ring.get(seg.start, len(samples)) if aec is not None else None)
            vad.pop()
        log("文件放完了")
        return

    import sounddevice as sd

    if args.list_devices:
        print(sd.query_devices(), flush=True)
        return

    # ---- 按**设备原生采样率**打开，再自己降到 16k
    # 直接跟 WASAPI 要 16000 会让驱动替我们转（质量不可控）；宁可多一步重采样
    try:
        info = sd.query_devices(args.device, "input")
        src_rate = int(round(float(info["default_samplerate"])))
    except Exception:
        src_rate = 16000
    resampler = open_resampler(src_rate)
    block_src = max(1, int(round(512 * src_rate / 16000)))

    log(f"开始听（设备 {args.device if args.device is not None else '默认'}，"
        f"{src_rate} Hz → 16000 Hz，重采样 {getattr(resampler, 'backend', '原样')}）"
        f"{'  [dry-run：只打印不写流]' if args.dry_run else ''}")

    pend = np.zeros(0, dtype=np.float32)          # 重采样后的余数：凑够 512 再喂
    with sd.InputStream(samplerate=src_rate, channels=1, dtype="float32",
                        blocksize=block_src, device=args.device) as stream:
        while True:
            block, _ = stream.read(block_src)
            x = np.asarray(block, dtype=np.float32).reshape(-1)
            if resampler is not None:
                x = resampler(x)
            pend = np.concatenate([pend, x])
            while len(pend) >= 512:
                chunk, pend = pend[:512], pend[512:]
                # 参考信号（loopback）永远给满 512：取不到时 LoopbackRef 补零，
                # 宁可这一拍少消一点回声，也不能让麦克风跟着卡住
                feed(chunk, lb.read(512) if lb is not None else None)


def main():
    ap = argparse.ArgumentParser(description="麦克风 → 文字 → 陪看聊天流")
    ap.add_argument("--engine", choices=["auto", "sense", "local", "http"], default="auto",
                    help="auto=有 SenseVoice 就用它，否则 paraformer；"
                         "sense=SenseVoice-Small；local=paraformer；http=共用 8000 服务")
    ap.add_argument("--url", default="http://127.0.0.1:8000", help="http 模式的服务地址")
    ap.add_argument("--models-dir", default=None, help="paraformer 目录（默认 D:/asr-local/models-sherpa）")
    ap.add_argument("--sense-dir", default=None, help="SenseVoice 目录（默认 D:/asr-local/models-sensevoice）")
    ap.add_argument("--language", default="zh", choices=["zh", "en", "ja", "ko", "yue", "auto"],
                    help="SenseVoice 的语言标签；中英混说很多时可以试 auto")
    ap.add_argument("--pad", type=float, default=0.25,
                    help="每段前面补多少秒（VAD 判开始是滞后的，补了才不吃首字；0 = 不补）")
    ap.add_argument("--device", type=int, default=None, help="麦克风设备号")
    ap.add_argument("--list-devices", action="store_true", help="列出输入设备后退出")
    ap.add_argument("--from-file", default=None, help="用 wav 文件代替麦克风（测试）")
    ap.add_argument("--min-sec", type=float, default=0.25,
                    help="短于这个秒数的段丢弃（0.35 会把「嗯/对/好」这种短答吞掉）")
    ap.add_argument("--threshold", type=float, default=0.003, help="音量门槛（RMS），滤环境噪声")
    ap.add_argument("--no-punct", action="store_true", help="不加标点")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写进聊天流")
    # ---- 回声消除（"只要麦克风，不要电脑声音"）
    ap.add_argument("--no-aec", action="store_true", help="关掉回声消除")
    ap.add_argument("--loopback", type=int, default=None,
                    help="loopback 设备号（pyaudiowpatch 的编号，默认取默认扬声器那条）。"
                         "列出来：python -c \"import pyaudiowpatch as p;a=p.PyAudio();"
                         "[print(d['index'],d['name']) for d in a.get_loopback_device_info_generator()]\"")
    ap.add_argument("--ref-file", default=None, help="用 wav 当回环参考（配合 --from-file 测试）")
    ap.add_argument("--taps", type=int, default=8192, help="滤波器长度（8192 ≈ 512ms 混响尾巴）")
    ap.add_argument("--dt-ratio", type=float, default=1.4,
                    help="双讲阈值：麦克风峰值超过参考峰值这么多倍就判定「你在说话」，冻住滤波器")
    ap.add_argument("--echo-gate", type=float, default=0.3,
                    help="消完只剩这么多比例就当纯回声丢掉（0 = 不判）。实测纯回声约剩 20%")
    args = ap.parse_args()

    if args.list_devices:
        import sounddevice as sd
        print(sd.query_devices(), flush=True)
        return

    try:
        run(args)
    except KeyboardInterrupt:
        log("停了")
    except ImportError as exc:
        log(f"缺依赖：{exc}\n  pip install sounddevice numpy（在 ASR 的 venv 里 numpy 已有）")
        return 2
    except Exception as exc:
        log(f"挂了：{exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
