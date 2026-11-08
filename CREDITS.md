# CREDITS.md

> 许可证与"这个项目不做什么"的声明在 [NOTICE](NOTICE)。本文件只记**谁做了这件事**。

这个仓库从 0.0.1 到现在，一半以上的判断是在别人的真实屏幕上试出来的：谁把片子放崩了、
谁在打游戏时被反复叫醒、谁的窗口卡在"进程活着但屏幕上什么都没有"。下面按"提出并推动了什么"记，
**不区分代码是否被逐行采用** —— 诊断、复现和反例同样计入。

## 1. 作者

[@SAOS-3624](https://github.com/SAOS-3624) —— 项目发起与维护。

## 2. 代码与设计贡献

| 贡献者 | 内容 |
|---|---|
| [@ggfgfgf-on](https://github.com/ggfgfgf-on) | 合并 7 个 PR，几乎全部打在**判帧算法**上：#11 两帧到 `maxWaitSec` 就封箱（静止画面不再等 40s）、#13 按宿主 patch 网格重算 token（推翻 384/218 旧口径）、#15 用 `mc` 运动补偿补切机位/相似构图的漏检、#18 低分前景门槛留余量、#19 高 `bg` 整屏前景确认、#22 端到端测试复用生产 ffmpeg 解析、#28 补 e2e 漏掉的 `execFileSync` import。另外还提了 issue #10/#12/#14/#16/#21/#26 —— 这个仓库最难的那部分（切点阈值、画布选择、延迟口径）基本都是他推着改的 |
| [@xingranya](https://github.com/xingranya) | #7 `voice` 按实例隔离适配器生命周期、保留同一 handler 的订阅去重；#23 显式窗口状态协议（`ready`/`closed`/`failed`），并把 `windowPidAlive` / `windowVerdict` 与 `test/heartbeat.test.mjs` 的 9 条断言原样保住 —— 后面所有窗口判活的改动都建在这上面 |
| [@citydirector](https://github.com/citydirector) | #24 给节奏参数做了一页设置面板（`maxAutonomousWakes` / `idleStopMin` / `defaultPace` / `speechPacing` 从此不用改源码）；#25 让"用哪个转写器"可配置（`listen.prefer`） |
| [@zhumengaoxuan](https://github.com/zhumengaoxuan) | #29 交付时附「这期间屏幕怎么动的」变化日志（默认关，按需打开） |
| [@gao804](https://github.com/gao804) | #30 `cutFutureLowBgMax: 0` 整条关掉低分未来帧确认，并补了合成回归 |
| [@caijialin20051003-gif](https://github.com/caijialin20051003-gif) | #9 只抓指定屏幕区域，并按区域实际比例出图（后面 `region` 那条链路的起点） |

## 3. 问题报告与诊断

| 报告者 | 内容 | 落地 |
|---|---|---|
| [@DightEndless](https://github.com/DightEndless) | [issue #32](https://github.com/SAOS-3624/dsh-see-now/issues/32) 悬浮窗「进程活着但永远看不见」：`hidden` 粘性无法自愈、`show:true` 会反噬、`status` 读文件不读真实可见性。还补了一条"窗口在 ≠ 正在看"的人机接口分析 | 前两条当次修掉（`hiddenForShow` 换算、`hidden` 加会话归属）；第三条让窗口把 `visible` 写进心跳，`windowReport()` 以事实为准 |
| [@erjiatie](https://github.com/erjiatie) | [issue #20](https://github.com/SAOS-3624/dsh-see-now/issues/20) 悬浮窗使用中的问题；[issue #17](https://github.com/SAOS-3624/dsh-see-now/issues/17) `ddagrab` 的 OBS 源起不来 | 采集失败现在会分类并给出证据（`captureErrorInfo`），不再只说"抓不到" |
| [@qinu321](https://github.com/qinu321) | [issue #8](https://github.com/SAOS-3624/dsh-see-now/issues/8) 多显示器拖不到第二块屏（附补丁与打桩 A/B 测试）；顺带提"连续唤醒上限希望能配置" | 直接变成 `maxAutonomousWakes` / `idleStopMin` 这两个可配项 |
| [@DFY520129](https://github.com/DFY520129) | [issue #5](https://github.com/SAOS-3624/dsh-see-now/issues/5) 三个体验问题：拍到自己窗口、省电档仍频繁唤醒、`say` 与聊天两条线 | 窗口默认走 `WDA_EXCLUDEFROMCAPTURE`；省电档的唤醒间隔重新定过 |
| [@moyi-anoko](https://github.com/moyi-anoko) | [issue #2](https://github.com/SAOS-3624/dsh-see-now/issues/2) 关掉悬浮窗后没有入口重开、高 DPI 未换算、`spawn` 失败静默（附本地的逐像素透明实现） | 有了 `see_now({action:"window", show:true})` 这条救命指令；开窗失败不再静默 |
| [@says693](https://github.com/says693) | [issue #1](https://github.com/SAOS-3624/dsh-see-now/issues/1) 持续陪看链路三个 bug：`peek` 丢弃已成图队列、会话归属竞争、`minFrames` 约束失效 | `reserveSheet` / `takeSheet` 那套"叫醒前先把图占住"就是为它做的 |
| [@TowardsDawn](https://github.com/TowardsDawn) | [issue #3](https://github.com/SAOS-3624/dsh-see-now/issues/3) 安装方式不够规范 | 已记入 README 的安装段 |

## 4. 运行时依赖

`examples/floating-chat/` 由同级项目 [dsh-watch-together](https://github.com/SAOS-3624/dsh-watch-together) 生成，
同作者、同许可证。其余第三方组件见 [NOTICE](NOTICE) 的 "Third-party components" 一节。

## 5. 如果将来真的要复制代码

本仓库不含任何第三方源代码。若将来某个实现参考了别处的代码，请在这里补一段：
来源、许可证、复制了哪几个文件、改了什么。空着就代表没有。
