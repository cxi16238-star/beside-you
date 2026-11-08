/**
 * dsh-see-now-plus —— 浏览器半身（fork 自 dsh-see-now）。
 *
 * 只做一件事：在 DSH 设置里放一页「看你在干什么」，让 `~/.dsh/see-now.json`
 * 里那九个值从"要改源码"变成"看得见、改得动、改错了会告诉你为什么"。
 *
 * ## 为什么这件事必须有界面
 *
 * 这些值原本写死在 `loop.js` 里。作者在 `tuning.js` 的注释里自己记着这件事
 * （读过源码的人只会在那儿看到一个 issue 编号），后来抽出了配置层和校验，
 * 但用户要动它仍然得手写 JSON —— 而写错一个类型就是"永远不停"或"立刻停"。
 *
 * ## 数据从哪来
 *
 * 走本插件自己的同源 `/api/see-now/*` 路由：`GET /status` 读、`POST /config` 写。
 * 校验规则**一条都不在这里**——全在 `src/tuning.js` 的 `readTuning` 里，
 * 前端只负责显示它给出的 `warnings`。前端另写一套规则，就一定会和宿主吵起来。
 *
 * ## 手写 ModuleLoader 包
 *
 * 不需要构建步骤，除 shell 已提供的 `react` 之外没有依赖。
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  // 必须是包名，不是插件的短名。client-modules 的 `arrive()` 拿着包名去查已经
  // 注册的 factory，名字对不上就一路抛 `loaded without registering "dsh-see-now-plus"`，
  // 而那条错误只进浏览器控制台 —— 宿主那头毫无异样，设置里就是干脆没有这一栏。
  //
  // fork 改名之后这里也必须跟着改：名字如果还对不上 `dsh-see-now-plus`，`arrive()`
  // 找不到 factory 就会拿备用 URL 再执行一遍同一个脚本，第二次 `register` 直接抛
  // `duplicate factory registration` —— 整页启动失败（v0.3.0 第一次装就是这么挂的）。
  id: 'her-company',
  factory: require => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useCallback, useRef, Fragment } = React;

    const NS = 'settings.seeNow';
    /** 路由前缀；与 `src/settings-api.mjs` 的 `ROUTE_PREFIX` 必须一致。 */
    const API = '/api/see-now';
    const inject = ['slots', 'locale'];

    // ── 文案 ──────────────────────────────────────────────────────────────────
    // 先只写中文：这一版的目标是"跑通"，双语等它成立之后再补一份 en 字典。
    const TEXT = {
      nav: '带上她的眼睛',
      title: '带上她的眼睛',
      sub: '让 AI 实时看屏幕、听声音，只在画面真的变了才交图。这里调的是"陪多久、多久看一次、一句听到哪儿算完"。'
        + '也可以直接在对话中用提示词让 Agent 读取屏幕。',
      'state.loading': '读取中…',
      'state.reload': '重新读取',
      'state.saved': '已自动保存',
      'state.savedLocal': '已保存，下一次转写开始使用新地址。',
      'state.nosave': '没有改动。',
      'sec.common': '常用',
      'sec.advanced': '高级（一般不用动）',
      'field.prefer': '用哪个转写服务',
      'field.prefer.hint': '宿主自带的是 SenseVoice（桌面版内置、零配置、不占显存）。下面那块 asr.json 是可选的自建或在线服务 —— 选「只用宿主自带的」时它不参与，那块配置会收起来。',
      'prefer.auto': '自动 —— 宿主自带的优先',
      'prefer.host': '只用宿主自带的（SenseVoice）',
      'prefer.local': '只用下面那个服务（asr.json）',
      'local.title': '转写服务（asr.json）',
      'local.instant': '修改即时生效（下一次转写开始使用）',
      'local.sub': '这个文件决定"声音用谁听写"。它与 video-storyboard 共用一份 —— 两个插件都读它，所以改这里对两边都生效。',
      'local.api': '接口形态',
      'local.api.hint': '多数服务是音频接口。只有聊天接口的服务（小米 MiMo 这类）才选第二种 —— 端点不一样，选错会 404。',
      'local.api.openai': '音频接口 /audio/transcriptions',
      'local.api.chat': '聊天接口 /chat/completions',
      'local.baseUrl': '服务地址',
      'local.baseUrl.hint': '要带版本路径，例如 https://api.example.com/v1。留空 = 不用这个文件。',
      'local.baseUrl.ph': 'https://api.example.com/v1',
      'local.model': '模型名',
      'local.model.hint': '按服务方的文档填。',
      'local.language': '语言',
      'local.language.hint': 'auto / zh / en，按服务支持的填。',
      'local.key': '密钥',
      'local.key.hint': '只写不读：文件里的 key 不会回显到页面上。留空表示不改。',
      'local.key.keep': '已设置，留空不改',
      'local.key.ph': '没设置',
      'local.empty': '这里还是空的。填了地址就能用；留空则由上面「用哪个转写服务」的规则决定。',
      'local.instant': '修改即时生效（下一次转写开始使用）',
      'local.sample': '看看这个文件长什么样',
      'local.sample.body': '{\n  "api": "openai-audio",\n  "baseUrl": "http://127.0.0.1:8000/v1",\n  "model": "paraformer-zh-2024-03-09",\n  "language": "auto"\n}',
      'local.manage': '文件里还有 manage（怎么把服务拉起来）一类的键，面板不动它们，原样保留。',
      'local.env': '环境变量正在覆盖这些字段',
      'field.pace': '场景变换侦测灵敏度',
      'field.pace.hint': '决定画面变化达到何种程度才算场景切换。分数越低越敏感，切点更密、唤醒更勤；越高仅选取大幅变化。',
      'pace.calm': '低 —— 20 分以上的变化才算（很久才出声）',
      'pace.normal': '中 —— 12 分（默认）',
      'pace.dense': '高 —— 7 分就算（反应快，话也多）',
      'pace.game-economic': '只挑大动作 —— 80 分（游戏省流）',
      'field.batch': '超省模式（攒几张再交）',
      'field.batch.hint': '攒满指定张数后一次性提交。默认 1 张最及时；张数越多请求越省，但画面到达更晚'
        + '（每张约 15~40 秒），会话越长收益越大。',
      'batch.1': '1 张 —— 攒满就交（默认）',
      'batch.2': '2 张',
      'batch.3': '3 张 —— 省得明显',
      'batch.4': '4 张 —— 最省，也最慢',
      'field.idleStop': '空闲多久自己收工',
      'field.idleStop.hint': '单位分钟；0 表示不自动收工（持续消耗 token）。',
      'field.pacing': '说话停顿跟着句长走',
      'field.pacing.hint': '按句长自动调整停顿：长句稍缓，短句稍紧。',
      'pacing.follow': '跟随句长（默认）',
      'pacing.guard': '取更晚的那个',
      'pacing.off': '关掉，固定间隔',
      'field.silence': '静音多久算一句说完',
      'field.silence.hint': '单位秒；低于 0.35 易将一句话从中间断开。',
      'field.maxSeg': '一句最长多久',
      'field.maxSeg.hint': '单位秒；到时强制断句，保证字幕及时输出。',
      'field.tierStyle': '每帧多大（档位）',
      'field.tierStyle.hint': '档位 1 占满一格，8 占 1/8。默认「标准」将 1 档压至 1/2 以节省张数；'
        + '需满格可选「原生」。',
      'tier.standard': '标准 —— 1 档压成 1/2（默认）',
      'tier.native': '原生 —— 算出几档就是几档，1 档也占满',
      'tier.full': '更大 —— 在密度基础上整体降一档',
      'tier.compact': '更小 —— 在密度基础上整体升一档',
      'tier.custom': '自定义 —— 逐档指定映射',
      'field.fillTierMap': '一键填满',
      'field.fillTierMap.pick': '全设成…',
      'field.fillTierMap.hint': '选择档位后八项统一设置；全部相同时密度不再影响尺寸。',
      'field.tierMap': '逐档映射',
      'field.tierMap.hint': '左侧为计算档位，右侧为实际输出档位。',
      'field.tierMode': '格子大小按什么算',
      'field.tierMode.hint': '「密度」按节奏快慢分级；「变化」按内容变化程度分级，可在同一图中对比大小。',
      'mode.density': '密度 —— 每秒几帧（默认）',
      'mode.weight': '变化 —— 变化越大格越大',
      'field.tierCurve': '七道阈值的取法',
      'field.tierCurve.hint': '阈值决定画面密度对应档位：「原始」为初始方案；「感知」按瞬时记忆定标（3~0.3 秒）。',
      'curve.docx': '原始（docx）',
      'curve.perceptual': '感知定标（3 s ~ 0.3 s）',
      'curve.custom': '自定义七个阈值',
      'field.tierThresholds': '七道阈值（帧/秒）',
      'field.tierThresholds.hint': '七项须严格递增，数值越大切换小格越晚。默认 0.26 / 0.6 / 0.9 / 1.2 / 1.8 / 2.4 / 3.0。',
      'tier.from': '档',
      'field.wakes': '自主唤醒上限',
      'field.wakes.hint': '无回应时自主唤醒的最大次数。',
      'field.imageTrigger': '涨到多少张就动手省',
      'field.imageTrigger.hint': '会话图片达到该数量后省略较早图片；0 表示关闭。',
      'field.imageKeep': '省完保留最近几张',
      'field.imageKeep.hint': '省略后保留的图片数；被省图片转为文字说明。100 张约 2.2 万 token，须小于触发线。',
      'field.live': '说长句时先出半截字幕',
      'field.live.hint': '关闭后须待整句结束才显示字幕。',
      'field.liveMin': '多长开始给半截',
      'field.liveMin.hint': '单位秒；到时生成快照开始转写。',
      'field.liveStep': '半截多久更新一次',
      'field.liveStep.hint': '单位秒；越小更新越频繁、转写越多，不可超过「一句最长」。',
      'field.pollMs': '多久查一次有没有新声音',
      'field.pollMs.hint': '单位毫秒；主要开销为断句等待。',
      'hint.restart': '「小窗与快捷键」即时生效；「常用」「高级」中的数值重启 DSH 后生效。',
      'restart.note': '数值即时保存，重启 DSH 后生效',
      'instant.note': '修改即时生效',
      'hint.path': '配置文件',
      'hint.origin': '默认值取自插件源码，非界面独立定义。',
      'warn.title': '配置里有几处它没接受，用的是默认值',
      'err.rejected': '这几项没通过校验，文件没有被改动：',
      'err.load': '读不到配置',
      'err.save': '保存失败',
      'note.file': '文件尚不存在；保存时新建，仅写入本次修改项。',
      'win.title': '大悬浮窗样式',
      'win.sub': '悬浮窗外观设置，修改即时生效。',
      'win.style': '外观预设',
      'win.style.auto': '自动 —— 远程/录屏用纯色，其余实时玻璃',
      'win.style.live': '实时玻璃 —— 跟着桌面模糊（好看，吃 CPU）',
      'win.style.frost': '静态磨砂 —— 不吃性能（低配机选这个）',
      'win.style.solid': '纯色 —— 最省，背后不透',
      'win.style.hint': '实时玻璃每帧抓屏并模糊，低配或高分屏环境可能卡顿；静态磨砂使用预生成底板，占用近零；纯色最省。',
      'win.applied': '已应用，窗口下一拍就换过来。',
      'win.path': '配置文件',
      'win.game': '打游戏的时候',
      'win.mode': '窗口',
      'win.mode.full': '正常显示',
      'win.mode.mini': '小悬浮窗（两条胶囊，还在屏幕上）',
      'win.mode.hidden': '真藏起来（withdraw + 托盘图标）',
      'win.mode.hint': '小悬浮窗保留全部按钮，缩至屏幕角落；隐藏模式仅保留托盘与弹幕，采集与播报不受影响。',
      'win.opacity': '背景透明度',
      'win.opacity.hint': '仅作用于窗口外壳；下限 25% 以保可读性。',
      'win.danmaku': '弹幕',
      'win.danmaku.off': '关',
      'win.danmaku.on': '开 —— 台词从屏幕顶部飘过',
      'win.danmaku.hint': '仅播报内容滚动；窗口收起后为唯一可见消息通道。',
      'win.game.hint': '游戏场景建议组合：隐藏窗口 + 开启弹幕 + 静态磨砂（零占屏、零抓屏）。',

      // ── 气泡与文字 ──
      'font.title': '文字样式',
  'font.sub': '正文字体、字号、颜色与粗细，修改即时生效。',
  'bub.title': '气泡',
      'bub.sub': '气泡出现、停留与数量上限，修改即时生效。',
      'bub.fontSize': '字号',
      'bub.fontColor': '颜色',
      'bub.fontBold': '加粗',
      'bub.fontFamily': '字体',
      'bub.fontFamily.ph': '留空使用系统默认',
      'bub.textOpacity': '文字透明度',
      'bub.bubbleColor': '气泡颜色',
      'bub.bubbleOpacity': '气泡透明度',
      'bub.stay': '气泡停留',
      'bub.max': '同时最多几条',
      'bub.autoShrink': '自动缩成小悬浮窗',
      'bub.autoShrink.on': '开 —— 静止一段时间自己缩',
      'bub.autoShrink.off': '关',
      'bub.shrinkAfter': '多久之后缩',
      'bub.hint.stay': '到时自动滑出并淡出；0 为常驻。',
      'bub.hint.max': '同时显示上限（1~3）；超出时替换最早一条。',
      'bub.hint.opacity': '三项分别作用于气泡底板、文字与窗口外壳。',
      'bub.hint.font': '需填写系统已安装字体；无效时回退默认。',
      'bub.hint.auto': '自动缩小与贴边隐藏尚未完善，暂不启用。',
      // ── 小窗与快捷键（这四项改完立刻生效，不用重开 DSH）──
      'talk.title': '小窗与快捷键',
      'talk.sub': '设置绑定会话、全局快捷键与焦点行为；修改即时生效。',
      'talk.session': '绑定会话',
      'talk.session.hint': '不绑定时跟随最近活跃会话；绑定后消息、唤醒与回复均固定于该会话。',
      'talk.follow': '不绑定 —— 跟随当前会话',
      'talk.current': '（当前）',
      'talk.missing': '（这个会话现在找不到了）',
      'talk.empty': '没读到会话列表',
      'talk.hotkey': '开关陪看的快捷键',
      'talk.hotkey.hint': '点击后按下组合键（1~3 键，至少一个非修饰键）；全局有效，Esc 取消。',
      'talk.hotkey.unset': '未设置 —— 点击录制',
      'talk.hotkey.rec': '请按键（Esc 取消）',
      'talk.hotkey.reset': '解绑',
      'talk.micHotkey': '麦克风快捷键',
      'talk.micHotkey.hint': '点按切换录音，与窗口麦克风按钮一致；1~3 键、至少一个非修饰键；勿与其他快捷键重复。',
      'talk.micHotkey.same': '与其他快捷键重复，请更换组合。',
      'talk.inputHotkey': '输入条快捷键',
      'talk.inputHotkey.hint': '唤起 / 收起输入条，与窗口「字」按钮一致；1~3 键、至少一个非修饰键；勿与其他快捷键重复。',
      'talk.saveAll': '',
      'talk.hotkey.warn': '勿使用 Ctrl+W / Ctrl+R / Ctrl+Q / F11 等系统占用组合，否则将被系统截获。',
      'talk.focusPause': 'DSH 获得焦点时暂停陪看',
      'talk.focusPause.hint': 'DSH 获得焦点时暂停陪看；仅在陪看状态下生效。',
      'talk.focusResume': '离开后自动续看',
      'talk.focusResume.hint': '该项已移至悬浮窗标题栏「焦点·DSH」：绿字自动续看，红字收工。',
      'talk.hotkeyWindow': '开始陪看时显示浮窗',
      'talk.hotkeyWindow.hint': '开启时按下快捷键即显示窗口；关闭时仅后台采集。',
      'talk.pauseSignal': '暂停陪看时发送最后画面',
      'talk.pauseSignal.hint': '陪看停下时（开关暂停、关闭浮窗、焦点判定暂停），向会话发送最后画面与暂停原因。',
      'talk.autoWatch': '跟随 DSH 启动开始陪看',
      'talk.autoWatch.hint': 'DSH 启动后自动开始陪看：优先绑定会话，其次最近活跃会话；启动 60 秒内无可用会话则放弃。',
      'talk.companion': '快捷键服务',
      'talk.companion.running': '运行中',
      'talk.companion.off': '未启用（未设置快捷键且未开启焦点暂停）',
      'talk.companion.unsupported': '这台机器上还没有 —— 前台窗口检测目前只做了 Windows',
      'talk.companion.bad': '起不来',
      'talk.companion.noFocus': '快捷键可用；本机不支持前台窗口检测',
      'talk.note': '会话列表实时获取；新会话需刷新显示。',
      'talk.search': '搜标题或 id…',
      'talk.pick': '选一个会话',
      'talk.idhint': '左侧为会话名，右侧为会话 ID，可选子智能体。',
    };

    const t = key => TEXT[key] ?? key;

    // ── 样式 ──────────────────────────────────────────────────────────────────
    const CSS = `
.sn_root{display:flex;flex-direction:column;gap:14px;padding:2px 0 8px}
.sn_hero{display:flex;flex-direction:column;gap:8px;padding:18px 20px;border-radius:16px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 86%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent))}
.sn_title{margin:0;font-size:19px;font-weight:740;letter-spacing:-.3px;color:var(--dsw-alias-label-primary)}
.sn_sub{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);max-width:78ch}
.sn_card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.sn_cardhd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.sn_cardname{font-size:13.5px;font-weight:660;color:var(--dsw-alias-label-primary)}
.sn_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.sn_field{display:flex;flex-direction:column;gap:5px;min-width:0}
.sn_label{font-size:12px;font-weight:620;color:var(--dsw-alias-label-primary)}
.sn_hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.sn_input,.sn_select{height:32px;padding:0 10px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sn_input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sn_select{cursor:pointer}
.sn_input:focus-visible,.sn_select:focus-visible{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.sn_check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.sn_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sn_btn{height:30px;padding:0 14px;border-radius:8px;font-size:12px;font-weight:620;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);
  color:var(--dsw-alias-label-primary)}
.sn_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l2)}
.sn_btn.primary{border-color:transparent;color:#fff;background:var(--dsw-alias-state-business-primary)}
.sn_btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 86%,#fff)}
.sn_btn:disabled{opacity:.5;cursor:not-allowed}
.sn_ok{font-size:11.5px;color:var(--dsw-alias-state-success-primary)}
.sn_restart{padding:8px 12px;border-radius:10px;font-size:11.5px;line-height:1.6;
  border:1px solid rgba(255,107,107,.35);background:rgba(255,107,107,.08);color:#ff7b7b}
.sn_red{font-size:11px;font-weight:620;color:#ff7b7b}
.sn_green{font-size:11px;font-weight:620;color:var(--dsw-alias-state-success-primary)}
.sn_note{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.sn_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.sn_box{padding:10px 12px;border-radius:10px;font-size:11.5px;line-height:1.6;word-break:break-word}
.sn_box.warn{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 40%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 8%,transparent);color:var(--dsw-alias-state-warning-primary,#f0a441)}
.sn_box.bad{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.sn_box ul{margin:4px 0 0;padding-left:18px}
.sn_box li{margin:2px 0}
.sn_det summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:2px 0}
.sn_pre{margin:8px 0 0;padding:10px 12px;border-radius:8px;overflow-x:auto;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.sn_cap{min-width:196px;height:32px;padding:0 12px;border-radius:8px;font-size:12px;cursor:pointer;
  text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  border:1px dashed color-mix(in srgb,var(--dsw-alias-border-l2) 92%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);color:var(--dsw-alias-label-primary)}
.sn_fontbar{align-items:center;gap:8px}
.sn_fontcard{margin-top:2px;border:1px solid rgba(120,160,210,.18)}
.sn_fbtn{width:34px;height:30px;border-radius:7px;border:1px solid var(--dsw-alias-border, #39506a);background:transparent;color:inherit;font-weight:800;font-size:14px;cursor:pointer}
.sn_fbtn.on{background:#2f7fd6;border-color:#5aa9ff;color:#fff}
.sn_fsel{min-width:150px;height:30px}
.sn_fsize{width:72px;height:30px}
.sn_preview{margin:2px 0 2px;padding:10px 12px;border-radius:12px;background:rgba(120,160,210,.07);border:1px dashed rgba(120,160,210,.25)}
.sn_prevbub{display:inline-block;padding:7px 14px;border-radius:12px;line-height:1.45;max-width:100%}
.sn_warnbig{color:#e05a5a;font-weight:700;font-size:13.5px;line-height:1.5}
.sn_ccur{position:relative;width:46px;height:20px;border-radius:5px;border:1px solid rgba(0,0,0,.45);overflow:hidden;cursor:pointer;flex:0 0 auto}
.sn_ccur input{position:absolute;left:-6px;top:-6px;width:calc(100% + 12px);height:calc(100% + 12px);opacity:0;cursor:pointer}
.sn_swatches{display:flex;gap:5px;align-items:center}
.sn_sw{width:18px;height:18px;border-radius:5px;border:1px solid rgba(0,0,0,.35);cursor:pointer;padding:0}
.sn_sw.on{outline:2px solid #5aa9ff;outline-offset:1px}
.sn_cap.bad{border-color:#e05a5a !important;color:#ffb4b4 !important;}
.sn_cap:hover{border-color:var(--dsw-alias-border-l2)}
.sn_cap.on{border-style:solid;border-color:var(--dsw-alias-state-business-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
/* 透明度滑条：占满一格，滑块颜色跟着主题走 */
.sn_range{width:100%;height:28px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
/* 紧凑数字输入：标签和框排在同一行，框只有 72px（省长度） */
.sn_field:has(input[type="number"]){flex-direction:row;align-items:center;gap:10px}
.sn_field .sn_input[type="number"]{width:72px;min-width:72px;flex:0 0 72px;
  height:30px;padding:0 6px;text-align:center;font-family:inherit;
  -moz-appearance:textfield;appearance:textfield}
.sn_field .sn_input[type="number"]::-webkit-outer-spin-button,
.sn_field .sn_input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
/* 颜色选择器：和输入框同高，去掉浏览器默认的白边 */
.sn_color{width:100%;height:32px;padding:2px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.sn_color::-webkit-color-swatch-wrapper{padding:0}
.sn_color::-webkit-color-swatch{border:0;border-radius:6px}
/* 会话选择器：原生 <select> 没法把 id 排到右边，只能自绘一层。 */
.sn_pick{position:relative}
.sn_pickbtn{display:flex;align-items:center;gap:10px;width:100%;height:32px;padding:0 10px;
  border-radius:8px;font-size:13px;cursor:pointer;text-align:left;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary)}
.sn_pickbtn:hover{border-color:var(--dsw-alias-border-l2)}
.sn_picktitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sn_pickid{flex:none;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--dsw-alias-label-tertiary)}
.sn_caret{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.sn_panel{position:absolute;z-index:30;left:0;right:0;top:36px;padding:6px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  box-shadow:0 12px 32px rgba(0,0,0,.38)}
.sn_filter{width:100%;height:28px;margin-bottom:6px;padding:0 8px;border-radius:6px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary)}
.sn_list{max-height:264px;overflow:auto}
.sn_opt{display:flex;align-items:center;gap:10px;width:100%;padding:6px 8px;border:0;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:left;cursor:pointer}
.sn_opt:hover{background:var(--dsw-alias-bg-layer-3)}
.sn_opt.on{background:var(--dsw-alias-state-business-primary);color:#fff}
.sn_opttitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sn_optid{flex:none;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--dsw-alias-label-tertiary)}
.sn_opt.on .sn_optid{color:rgba(255,255,255,.82)}
.sn_none{padding:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
`;

    /**
     * 一个带超时的 JSON 请求。
     *
     * 没有超时的话，Host 正忙时一次挂起的 fetch 会让整页永远停在"读取中"。
     */
    async function api(path, options) {
      const { timeout = 15000, ...rest } = options ?? {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(API + path, { ...rest, signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const why = body && Array.isArray(body.rejected) ? body.rejected.join('；') : `HTTP ${res.status}`;
          throw new Error(why);
        }
        if (body === null) throw new Error('返回值不是 JSON');
        return body;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * 表单草稿：扁平结构，读起来比嵌套少一层心智负担。
     *
     * **必须把「界面上渲染过的每一项」都种进来**，一项不落。`patchOf` 是按
     * 「draft 与 values 逐项比较、不等即视为用户改过」算补丁的：种子缺了谁，
     * draft 那边就是 `undefined`，与真实值永远不等，于是每次保存都会捎上一个
     * 空值幽灵字段（`tierStyle: ""` / `tierMap: []`）。而 `tuning.js` 的规矩是
     * 「本次提交让警告变多 → 整笔拒绝、文件不动」，所以只要缺一项，用户改什么都存不下去。
     */
    function draftOf(values) {
      const listen = values?.listen ?? {};
      return {
        maxAutonomousWakes: values.maxAutonomousWakes,
        imageTrigger: values.imageTrigger,
        imageKeep: values.imageKeep,
        idleStopMin: values.idleStopMin,
        wakeBatch: values.wakeBatch,
        defaultPace: values.defaultPace,
        speechPacing: values.speechPacing,
        // tierMap 是数组：给引用即可，patchOf 用 JSON.stringify 比内容，没有原地改的风险
        tierStyle: values.tierStyle,
        tierMap: values.tierMap,
        // 数组同理给引用（patchOf 用 JSON.stringify 比内容）
        tierMode: values.tierMode,
        tierCurve: values.tierCurve,
        tierThresholds: values.tierThresholds,
        prefer: listen.prefer,
        live: listen.live,
        liveMin: listen.liveMin,
        liveStep: listen.liveStep,
        silence: listen.silence,
        maxSeg: listen.maxSeg,
        pollMs: listen.pollMs,
        // 小窗绑谁 / 快捷键 / 焦点：四项都存 see-now.json，改完立刻生效
        talkSession: values.talkSession ?? 'follow',
        // 数组给引用即可（patchOf 用 JSON.stringify 比内容，理由同 tierMap）
        hotkey: values.hotkey ?? [],
        micHotkey: values.micHotkey ?? [],
        inputHotkey: values.inputHotkey ?? [],
        focusPause: values.focusPause === true,
        focusResume: values.focusResume !== false,
        hotkeyWindow: values.hotkeyWindow !== false,
        pauseSignal: values.pauseSignal === true,
        autoWatchOnStart: values.autoWatchOnStart === true,
      };
    }

    /**
     * 按段浅合并两份 values。
     *
     * 宿主 `/config` 的回包现在给的是**写完之后文件里的完整快照**，但面板不该赌
     * 宿主一定是新版 —— 老实现回的是 `writeTuning().values`，按"只写提交过的键"
     * 的语义只有本次提交的那几个，合并一次两种都能用。
     */
    function mergeValues(prev, next) {
      const base = prev ?? {};
      const patch = next ?? {};
      return {
        ...base,
        ...patch,
        listen: { ...(base.listen ?? {}), ...(patch.listen ?? {}) },
      };
    }

    /** 输入框里的字符串换成数字；空串或非数就原样交给宿主去判（它会拒，并给出原因）。 */
    const num = value => {
      if (typeof value === 'number') return value;
      const text = String(value ?? '').trim();
      if (text === '') return Number.NaN;
      return Number(text);
    };

    /**
     * 只把**改过**的键做成补丁。
     *
     * 整体提交虽然也能跑，但它会在用户什么都没动的情况下把一整份默认值写进文件 ——
     * 而 `tuning.js` 的初衷是"用户只写自己想改的那几项"。
     */
    function patchOf(draft, values) {
      // `draftOf` 对空 values 有兜底（`values?.listen ?? {}`），这里也不能假设一定齐全：
      // 老宿主回的包只带本次提交过的键，没提交过 listen 段时它就是 undefined。
      const base = values ?? {};
      const patch = {};
      for (const key of ['maxAutonomousWakes', 'imageTrigger', 'imageKeep', 'idleStopMin', 'wakeBatch', 'defaultPace', 'speechPacing']) {
        if (draft[key] !== base[key]) patch[key] = key === 'defaultPace' || key === 'speechPacing'
          ? draft[key]
          : num(draft[key]);
      }
      if (draft.tierStyle !== base.tierStyle) patch.tierStyle = String(draft.tierStyle ?? '');
      if (draft.tierMode !== base.tierMode) patch.tierMode = String(draft.tierMode ?? '');
      if (draft.tierCurve !== base.tierCurve) patch.tierCurve = String(draft.tierCurve ?? '');
      // 数组比引用永远不等，只能比内容；顺序有意义（第 i 个 = 档位 i+1）
      if (JSON.stringify(draft.tierMap ?? null) !== JSON.stringify(base.tierMap ?? null)) {
        patch.tierMap = (Array.isArray(draft.tierMap) ? draft.tierMap : []).map((n) => num(n));
      }
      if (JSON.stringify(draft.tierThresholds ?? null) !== JSON.stringify(base.tierThresholds ?? null)) {
        patch.tierThresholds = (Array.isArray(draft.tierThresholds) ? draft.tierThresholds : []).map((n) => num(n));
      }
      const cur = base.listen ?? {};
      const listen = {};
      for (const key of ['prefer', 'live', 'liveMin', 'liveStep', 'silence', 'maxSeg', 'pollMs']) {
        if (draft[key] === cur[key]) continue;
        // prefer 是枚举字符串，不能交给 num()（那会把 'host' 换成 NaN）
        listen[key] = key === 'live' ? draft[key] === true
          : key === 'prefer' ? String(draft[key] ?? '')
          : num(draft[key]);
      }
      if (Object.keys(listen).length > 0) patch.listen = listen;
      /**
       * 小窗与快捷键这四项**不在 listen 段里**，也不走 num()：两个字符串、一个数组、
       * 两个布尔。逐项比过才提交 —— 补丁只该带用户真改过的那几个键。
       */
      if ((draft.talkSession ?? 'follow') !== (base.talkSession ?? 'follow')) {
        patch.talkSession = String(draft.talkSession ?? 'follow').trim() || 'follow';
      }
      if (JSON.stringify(draft.hotkey ?? []) !== JSON.stringify(base.hotkey ?? [])) {
        patch.hotkey = Array.isArray(draft.hotkey) ? draft.hotkey.map(k => String(k)) : [];
      }
      if (JSON.stringify(draft.micHotkey ?? []) !== JSON.stringify(base.micHotkey ?? [])) {
        patch.micHotkey = Array.isArray(draft.micHotkey) ? draft.micHotkey.map(k => String(k)) : [];
      }
      if (JSON.stringify(draft.inputHotkey ?? []) !== JSON.stringify(base.inputHotkey ?? [])) {
        patch.inputHotkey = Array.isArray(draft.inputHotkey) ? draft.inputHotkey.map(k => String(k)) : [];
      }
      // 布尔不能直接比 `!==`：draft 里可能是 `undefined`（老宿主回的包没这个键），
      // 那和"用户去掉了勾"不是一回事。先归一到「它到底开没开」。
      if ((draft.focusPause === true) !== (base.focusPause === true)) {
        patch.focusPause = draft.focusPause === true;
      }
      if ((draft.focusResume !== false) !== (base.focusResume !== false)) {
        patch.focusResume = draft.focusResume !== false;
      }
      if ((draft.hotkeyWindow !== false) !== (base.hotkeyWindow !== false)) {
        patch.hotkeyWindow = draft.hotkeyWindow !== false;
      }
      if ((draft.autoWatchOnStart === true) !== (base.autoWatchOnStart === true)) {
        patch.autoWatchOnStart = draft.autoWatchOnStart === true;
      }
      if ((draft.pauseSignal === true) !== (base.pauseSignal === true)) {
        patch.pauseSignal = draft.pauseSignal === true;
      }
      return patch;
    }

    // ── 快捷键的显示与录制 ────────────────────────────────────────────────────
    /** 修饰键的固定次序：显示、提交都用这一份，否则 `Shift+Ctrl+K` 与 `Ctrl+Shift+K` 会来回抖。 */
    const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Win'];

    /**
     * 录完最后一个键之后，等这么久没人再按才定稿。
     *
     * 以前是"第一个非修饰键按下去就提交"——想设 `Ctrl+Alt+K` 的人刚按到 K 就被收走了，
     * 第二个第三个键根本来不及按。0.7 秒是"手停下来了"和"别让人干等"之间的折中。
     */
    const HOTKEY_SETTLE_MS = 700;
/** 气泡/文字设置的兜底默认值（宿主没回 `ui` 时用；和 src/window.js 的默认一致）。 */
const UI_FALLBACK = Object.freeze({
  autoShrink: false,
  shrinkAfter: 20,
  bubbleStay: 8,
  bubbleMax: 3,
  textOpacity: 1,
  bubbleOpacity: 1,
  fontSize: 11,
  fontColor: '#edf6ff',
  fontBold: false,
  fontFamily: '',
});


    /**
     * 把这一下按到的键并进已经攒下的键里。
     *
     * 必须并进去而不是覆盖：用户很可能是**一次一个**地按（按住 Ctrl → 松开 → 再按 K），
     * 那样每个 keydown 事件里只有当时还按着的修饰键，覆盖就会把前面的丢了。
     * 修饰键排前面、其余保持按下顺序（`hotkeyText` 显示时也会这么排）。
     */
    function mergeHotkeyKeys(prev, pressed) {
      const out = [];
      for (const k of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(pressed) ? pressed : [])]) {
        if (!out.includes(k)) out.push(k);
      }
      return out.sort((a, b) => {
        const ia = MOD_ORDER.indexOf(a);
        const ib = MOD_ORDER.indexOf(b);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return 0;
      });
    }

    /**
     * 浏览器给的事件键名 → 存盘的键名。
     *
     * 存**物理键**的名字（`Minus` 而不是 `-`）：`src/hotkeys.js` 和
     * `examples/floating-chat/companion.py` 共用同一张名字表，Python 那边靠名字查 VK 码。
     * 这里漏一个，用户在界面上按得出来、存下去却按不动 —— 所以不做"猜"，认不出就返回 null。
     */
    /** 被宿主/系统先占住的组合（注册了会和窗口/浏览器快捷键打架）。 */
    const HOTKEY_BLOCKED = [
      ['Ctrl', 'W'], ['Ctrl', 'R'], ['Ctrl', 'Q'], ['Ctrl', 'T'], ['Ctrl', 'N'],
      ['Ctrl', 'Shift', 'Esc'], ['Alt', 'F4'], ['Ctrl', 'Alt', 'Del'],
      ['F11'], ['F5'],
    ];

    /**
     * 判定一个组合能不能用 —— 返回 ''(能用) / 'weak' / 'blocked'。
     *
     * 和别的软件一个口径：
     * - 只有修饰键 → 不算组合；
     * - **一个非修饰键、又没有任何 Ctrl/Alt/Win** → 太简单了，会挡住打字
     *   （Shift+K 这种也不行：它会吃掉大写字母）；
     * - 明确被宿主/系统占住的组合 → 不让存。
     */
    function hotkeyProblem(keys) {
      const arr = Array.isArray(keys) ? keys : [];
      if (arr.length === 0) return '';
      const nonMod = arr.filter(k => !MOD_ORDER.includes(k));
      if (nonMod.length === 0) return 'weak';
      const strong = arr.includes('Ctrl') || arr.includes('Alt') || arr.includes('Win');
      if (!strong) return 'weak';
      const low = arr.map(k => String(k).toLowerCase()).sort().join('+');
      for (const combo of HOTKEY_BLOCKED) {
        const key = combo.map(k => String(k).toLowerCase()).sort().join('+');
        if (low === key) return 'blocked';
      }
      return '';
    }

    const KEY_ALIASES = {
      Control: 'Ctrl', Ctrl: 'Ctrl', Meta: 'Win', OS: 'Win', Super: 'Win',
      // 单按修饰键不该被当成一个"组合"，但**必须认得出来**：录制时要靠它
      // 走"只更新预览、不提交"那条分支，否则按 Ctrl 会被当成一个叫 Control 的键。
      Alt: 'Alt', AltGraph: 'Alt', Shift: 'Shift',
      Escape: 'Esc', Esc: 'Esc',
      ' ': 'Space', Space: 'Space', Spacebar: 'Space',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
      '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
      ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
    };

    function keyNameOf(event) {
      const raw = String(event?.key ?? '');
      if (!raw) return null;
      if (KEY_ALIASES[raw]) return KEY_ALIASES[raw];
      if (/^[a-zA-Z]$/.test(raw)) return raw.toUpperCase();
      if (/^[0-9]$/.test(raw)) return raw;
      if (/^F([1-9]|1[0-2])$/.test(raw)) return raw;
      if (/^(Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/.test(raw)) return raw;
      return null;
    }

    /** `['Ctrl','Alt','K']` → `'Ctrl+Alt+K'`；空数组给空串（界面上显示「还没设」）。 */
    function hotkeyText(keys) {
      const list = Array.isArray(keys) ? keys.map(k => String(k)) : [];
      if (list.length === 0) return '';
      const mods = MOD_ORDER.filter(m => list.includes(m));
      const rest = list.filter(k => !MOD_ORDER.includes(k));
      return [...mods, ...rest].join('+');
    }

    // ── asr.json 的那一份草稿 ─────────────────────────────────────────────────
    // 单独一套，因为它写的是另一个文件：改了立刻对下一次转写生效，不用重开 DSH。
    // key 永远是空串起步 —— 后端不回传密钥，所以"草稿里没有 key" 与 "文件里没有 key"
    // 是两件事，靠 hasKey 区分。
    const ASR_FIELDS = ['api', 'baseUrl', 'model', 'language'];

    function localDraftOf(local) {
      if (!local || typeof local !== 'object') return null;
      return {
        api: local.api || 'openai-audio',
        baseUrl: local.baseUrl || '',
        model: local.model || '',
        language: local.language || '',
        key: '',
      };
    }

    /** 只提交真的改过的那几个键；key 只在用户真填了的时候才带。 */
    function localPatchOf(draft, local) {
      const patch = {};
      if (!draft || !local) return patch;
      for (const key of ASR_FIELDS) {
        const next = String(draft[key] ?? '').trim();
        if (next !== String(local[key] ?? '').trim()) patch[key] = next;
      }
      const key = String(draft.key ?? '').trim();
      if (key !== '') patch.key = key;
      return patch;
    }

    /**
     * asr.json 那块只在**可能用到它**的时候出现。
     *
     * 原来它顶在最上面，看起来像"转写已经换成这个自建服务了"——实际上宿主自带的
     * SenseVoice 一直在，选了 local 才轮到 asr.json。所以：选「只用宿主自带的」
     * 时整块收起来，别让配置项的存在暗示了不存在的替换关系。
     */
    const shouldShowLocal = (prefer) => prefer !== 'host';

    // ── 设置页 ────────────────────────────────────────────────────────────────
    function SettingsPage() {
      const [data, setData] = useState(null);
      const [draft, setDraft] = useState(null);
      const [error, setError] = useState('');
      const [rejected, setRejected] = useState([]);
      const [busy, setBusy] = useState(true);
      const [savedAt, setSavedAt] = useState(0);
      // asr.json 那一套是独立的：不同文件、不同生效方式（改完立刻生效）。
      const [localDraft, setLocalDraft] = useState(null);
      const [localRejected, setLocalRejected] = useState([]);
      const [localAt, setLocalAt] = useState(0);
      // 悬浮窗样式又是另一个文件（watch-window.json）：也是改完立刻生效，所以单独一套状态
      const [windowStyle, setWindowStyleState] = useState('');
      const [windowAt, setWindowAt] = useState(0);
      // 透明度：拖动时先改本地值（手感），再 80ms 一次落盘 ——
      // 用户明确要求"跟着滑动调，不要松开鼠标才调"，所以不能用"停手才发"的防抖。
      const [opacity, setOpacity] = useState(null);
      const opacityTimer = useRef(null);
      // 气泡/文字/字体：同样是 watch-window.json，但走 `ui` 这一组键
      const [uiDraft, setUiDraft] = useState(null);
      const liveTimer = useRef(null);
      const livePending = useRef(null);
      // 快捷键录制：开着的时候整页都在听 keydown（见下面的 effect）
      const [capturing, setCapturing] = useState(false);
      const [captureTarget, setCaptureTarget] = useState('hotkey'); // 'hotkey' | 'micHotkey'
      const [capturePreview, setCapturePreview] = useState('');
      const [captureBad, setCaptureBad] = useState('');   // '' | 'weak' | 'blocked' 
      // 录的时候按下的键先攒在这儿，手停下来（HOTKEY_SETTLE_MS 内没人再按）才定稿。
      // 不能"一按就定"：想设 Ctrl+Alt+K 的人得能一个键一个键按完。
      const captureKeys = useRef([]);
      const captureTimer = useRef(null);
      // 会话选择器自己展开一层面板：原生 <select> 没地方放"右边的 id"，也没法加搜索框。
      const [pickOpen, setPickOpen] = useState(false);
      const [pickQuery, setPickQuery] = useState('');
      // 面板的范围：点在外面就收起来（见下面的 effect）。用 ref 而不是给 document
      // 挂一堆选择器 —— 面板是 React 渲染的，只有它能告诉我们"这是自己人"。
      const pickBox = useRef(null);
      const clearCaptureTimer = () => {
        if (captureTimer.current !== null) {
          clearTimeout(captureTimer.current);
          captureTimer.current = null;
        }
      };

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const next = await api('/status');
          setData(next);
          setDraft(draftOf(next.values));
          setLocalDraft(localDraftOf(next.local));
          setWindowStyleState(next.window?.style ?? 'auto');
          // 服务器快照就是真相：草稿清掉，滑块才不会卡在本地旧值上
          setOpacity(null);
          setUiDraft(null);
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const set = (key, value) => {
        setSavedAt(0);
        setRejected([]);
        // 所有设置即时保存：改一个键就自动落盘，不再需要「保存全部」按钮。
        // 数值输入框会连续触发，用 250ms 防抖合并，最后一个值才是发出去的。
        setDraft(current => {
          const next = { ...current, [key]: value };
          commitSoon(next);
          return next;
        });
      };

      /**
       * 改逐档映射里的一项。
       *
       * 必须**整份数组换新**（不能原地改）：`patchOf` 靠比较两份 draft 来算补丁，
       * 原地改会让"改过"和"没改"看起来一样，那一项就永远提交不上去。
       */
      const setTierMap = (i, v) => {
        const base = Array.isArray(draft?.tierMap) ? draft.tierMap : [1, 2, 3, 4, 5, 6, 7, 8];
        const next = base.map((x) => Number(x));
        next[i] = Number(v);
        set('tierMap', next);
      };

      /**
       * 改七道阈值里的一道。同样整份换新（理由同 `setTierMap`）。
       * 输入框存**字符串**：空串和非数字都留给宿主去拒，前端不替它猜。
       */
      const setThreshold = (i, v) => {
        const base = Array.isArray(draft?.tierThresholds)
          ? draft.tierThresholds
          : (data?.defaults?.tierThresholds ?? []);
        const next = base.slice();
        next[i] = v;
        set('tierThresholds', next);
      };

      /**
       * 拖背景透明度：本地立刻跟手，落盘走 `livePatch`（80ms 封顶，跟手但不是每像素一发）。
       */
      const touchOpacity = (value) => {
        setOpacity(value);
        livePatch({ opacity: value });
      };
      // 服务器那边有值就听它的；拖动过程中先听本地的（不然滑块会被旧值弹回去）
      const opacityPct = Math.round(
        Math.max(0.25, Math.min(1, opacity ?? Number(data?.window?.opacity ?? 1))) * 100,
      );

      // 即时保存：250ms 防抖，把改过的那几个键做成补丁发出去（所有设置无保存按钮）
      const commitTimer = useRef(null);
      const commitSoon = (nextDraft) => {
        if (commitTimer.current !== null) clearTimeout(commitTimer.current);
        commitTimer.current = setTimeout(() => {
          commitTimer.current = null;
          void commit(nextDraft);
        }, 250);
      };
      const commit = async (nextDraft) => {
        if (data === null) return;
        const patch = patchOf(nextDraft, data.values);
        if (Object.keys(patch).length === 0 && patch.listen === undefined) return;
        setBusy(true);
        setError('');
        setRejected([]);
        try {
          const result = await api('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          });
          if (result.ok) {
            const merged = mergeValues(data.values, result.values);
            setData(current => (current ? { ...current, values: merged, warnings: result.warnings, path: result.path } : current));
            setDraft(draftOf(merged));
            setSavedAt(Date.now());
          } else {
            setRejected(result.rejected ?? []);
          }
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      };

      const localCommitTimer = useRef(null);
      const commitLocalSoon = (nextDraft) => {
        if (localCommitTimer.current !== null) clearTimeout(localCommitTimer.current);
        localCommitTimer.current = setTimeout(() => {
          localCommitTimer.current = null;
          void saveLocal(nextDraft);
        }, 250);
      };

      const setLocal = (key, value) => {
        setLocalAt(0);
        setLocalRejected([]);
        setLocalDraft(current => {
          const next = { ...(current ?? {}), [key]: value };
          commitLocalSoon(next);
          return next;
        });
      };

      const saveLocal = async (draftOverride) => {
        if (data === null) return;
        const patch = localPatchOf(draftOverride ?? localDraft, data.local);
        if (Object.keys(patch).length === 0) {
          setLocalAt(-1);
          return;
        }
        setBusy(true);
        setError('');
        setLocalRejected([]);
        try {
          const result = await api('/local', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          });
          if (result.ok) {
            // 同 save()：以宿主回的快照为准，别把草稿当真相。
            setData(current => ({ ...current, local: result.local }));
            setLocalDraft(localDraftOf(result.local));
            setLocalAt(Date.now());
          } else {
            setLocalRejected(result.rejected ?? []);
          }
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setBusy(false);
        }
      };

      /**
       * 换悬浮窗样式：单独一条路由，**不跟主表单一起提交**。
       *
       * 它写的是 watch-window.json（窗口自己也在写 geometry/name/hidden），
       * 和 see-now.json 不是一份文件；而且窗口盯着这个文件的 mtime，改完就换 ——
       * 没有必要让用户再点一次「保存」。
       */
      const applyWindow = async (patch) => {
        if (patch.style !== undefined) setWindowStyleState(patch.style);
        setWindowAt(0);
        setError('');
        try {
          const result = await api('/window', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          });
          if (result.ok) {
            setData(current => (current ? { ...current, window: result.window } : current));
            setWindowAt(Date.now());
          } else {
            setError((result.rejected ?? []).join('；'));
          }
        } catch (err) {
          setError(String(err?.message ?? err));
        }
      };

      /**
       * 拖动类控件的"跟着手走"：**先发一次，再 80ms 一次封顶**。
       *
       * 不能用"停手才发"的防抖 —— 用户的原话是「跟随滑动调节透明度，不要松开鼠标才调」。
       * 也不能每个像素都发：那会变成每秒几十次"读改写同一份 watch-window.json"。
       */
      const livePatch = (patch) => {
        livePending.current = { ...(livePending.current ?? {}), ...patch };
        if (liveTimer.current !== null) return;
        const fire = () => {
          const pending = livePending.current;
          livePending.current = null;
          liveTimer.current = null;
          if (pending) void applyWindow(pending);
          if (livePending.current) liveTimer.current = setTimeout(fire, 80);
        };
        liveTimer.current = setTimeout(fire, 0);
      };

      /** 读一个 ui 值：草稿优先，其次服务器快照，最后是内置默认。 */
      const uiValue = (key) => {
        const local = uiDraft?.[key];
        if (local !== undefined) return local;
        const remote = data?.window?.ui?.[key];
        return remote !== undefined ? remote : UI_FALLBACK[key];
      };

      /** 改一个 ui 值：先本地（滑块才跟手），再走 livePatch 落盘。 */
      const setUi = (key, value) => {
        setUiDraft(current => ({ ...(current ?? {}), [key]: value }));
        livePatch({ ui: { [key]: value } });
      };

      /**
       * 录制快捷键：整页接管 keydown。
       *
       * 四个细节：
       *  - **capture 阶段 + preventDefault**：`Ctrl+W` / `Ctrl+R` 这类宿主加速键平时
       *    会先被吃掉，只有在这里抢在它们前面拦一道，用户按下的组合才可能记下来；
       *  - 只按了修饰键（Ctrl/Alt/Shift/Win）时不提交，只把预览拼出来 —— 否则
       *    "按下 Ctrl" 就会被记成 `Ctrl`，而那不是一个能用的开关；
       *  - **攒着 + 静默之后才定稿**：每按一下就重置 `HOTKEY_SETTLE_MS` 的定时器，
       *    手停下来才提交。一按就提交的话，想设三键组合的人第二个键还没按到就被收走了；
       *  - 用 `e.code` 的思路不行：我们要的是显示名，`e.key` 在各种输入法/布局下更稳，
       *    认不出来的一律忽略（不猜）。
       */
      useEffect(() => {
        if (!capturing) return undefined;
        const onKey = (e) => {
          if (e.repeat) return;
          const name = keyNameOf(e);
          if (!name) return;
          e.preventDefault();
          e.stopPropagation();
          if (name === 'Esc') {
            clearCaptureTimer();
            captureKeys.current = [];
            setCapturing(false);
            setCapturePreview('');
            return;
          }
          const mods = [];
          if (e.ctrlKey) mods.push('Ctrl');
          if (e.altKey) mods.push('Alt');
          if (e.shiftKey) mods.push('Shift');
          if (e.metaKey) mods.push('Win');
          const isModifier = MOD_ORDER.includes(name);
          const pressed = isModifier ? mods : [...mods.filter(m => m !== name), name];
          const next = mergeHotkeyKeys(captureKeys.current, pressed);
          // 上限三个键：多余的按键**直接不收**（而不是收下再让宿主整笔拒掉 ——
          // 那样用户只会在保存时看到一句"被拒绝"，还看不出是哪个键多的）
          if (next.length > 3) return;
          captureKeys.current = next;
          setCapturePreview(hotkeyText(next));
          clearCaptureTimer();
          // 还只有修饰键：继续等真正的那个键，不定稿
          if (!next.some(k => !MOD_ORDER.includes(k))) return;
          captureTimer.current = setTimeout(() => {
            captureTimer.current = null;
            const keys = captureKeys.current;
            const why = hotkeyProblem(keys);
            if (why) {
              // 不合法：**不定稿**，把组合留在框里 + 标红说明，用户还能接着按
              setCapturePreview(`${hotkeyText(keys)}  ·  ${t(why === 'blocked'
                ? 'talk.hotkey.blocked' : 'talk.hotkey.weak')}`);
              setCaptureBad(why);
              captureKeys.current = [];
              return;
            }
            captureKeys.current = [];
            setCapturing(false);
            setCapturePreview('');
            setCaptureBad('');
            if (keys.length > 0) {
              // 和另外两条快捷键里的任何一条重了 = 动作会一起触发，当场拦住不让存
              const otherA = captureTarget === 'hotkey'
                ? (draft?.micHotkey ?? [])
                : (draft?.hotkey ?? []);
              const otherB = captureTarget === 'inputHotkey'
                ? (draft?.micHotkey ?? [])
                : (draft?.inputHotkey ?? []);
              const clash = (otherA.length > 0 && JSON.stringify(keys) === JSON.stringify(otherA))
                || (otherB.length > 0 && JSON.stringify(keys) === JSON.stringify(otherB));
              if (clash) {
                setCapturePreview(`${hotkeyText(keys)}  ·  ${t('talk.micHotkey.same')}`);
                setCaptureBad('blocked');
                return;
              }
              set(captureTarget, keys);
            }
          }, HOTKEY_SETTLE_MS);
        };
        window.addEventListener('keydown', onKey, true);
        return () => {
          window.removeEventListener('keydown', onKey, true);
          // 卸载/关闭录制时把没定稿的定时器收掉，别在组件没了之后还 setState
          clearCaptureTimer();
        };
        // `set` 每次渲染都是新的闭包，但它只碰 draft；这里只该在开关变化时重挂监听
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [capturing]);

      /**
       * 会话面板：点在外面就收起来。
       *
       * 用 capture 阶段监听 `mousedown` 而不是 `click`：点别处的按钮时先收起面板，
       * 那个按钮自己那一下照常生效（换成 click 的话，有的控件会先吃掉这一下）。
       * `pickBox.current.contains` 判断"是不是自己人"—— 面板里的搜索框、选项、
       * 滚动条都算，点在它们上面不会误收。
       */
      useEffect(() => {
        if (!pickOpen) return undefined;
        const onDown = (e) => {
          if (pickBox.current && !pickBox.current.contains(e.target)) {
            setPickOpen(false);
            setPickQuery('');
          }
        };
        window.addEventListener('mousedown', onDown, true);
        return () => window.removeEventListener('mousedown', onDown, true);
      }, [pickOpen]);

      if (data === null || draft === null) {
        return h('div', { className: 'sn_root' },
          h('div', { className: 'sn_hero' },
            h('h2', { className: 'sn_title' }, t('title')),
            h('p', { className: 'sn_sub' }, t('sub'))),
          error !== '' ? h('div', { className: 'sn_box bad' }, `${t('err.load')}：${error}`) : h('div', { className: 'sn_note' }, t('state.loading')),
          h('div', { className: 'sn_row' }, h('button', { className: 'sn_btn', onClick: load, disabled: busy }, t('state.reload'))));
      }

      const field = (key, labelKey, hintKey, props) => h('label', { className: 'sn_field', key },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('input', {
          className: 'sn_input',
          type: 'number',
          value: String(draft[key] ?? ''),
          onChange: e => set(key, e.target.value),
          ...props,
        }),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      const select = (key, labelKey, hintKey, options) => h('label', { className: 'sn_field', key },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('select', {
          className: 'sn_select',
          // 缺种时给空串：`String(undefined)` 会让下拉框渲染出一个名为 "undefined" 的选项
          value: String(draft[key] ?? ''),
          onChange: e => set(key, e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value),
        }, options.map(([value, text]) => h('option', { key: String(value), value: String(value) }, text))),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      // asr.json 那一套的控件：数据源是 localDraft，不是 draft（两个不同的文件）。
      const localField = (key, labelKey, hintKey, props) => h('label', { className: 'sn_field', key: `l_${key}` },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('input', {
          className: 'sn_input',
          value: String(localDraft?.[key] ?? ''),
          onChange: e => setLocal(key, e.target.value),
          ...props,
        }),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      const localSelect = (key, labelKey, hintKey, options) => h('label', { className: 'sn_field', key: `l_${key}` },
        h('span', { className: 'sn_label' }, t(labelKey)),
        h('select', {
          className: 'sn_select',
          value: String(localDraft?.[key] ?? ''),
          onChange: e => setLocal(key, e.target.value),
        }, options.map(([value, text]) => h('option', { key: String(value), value: String(value) }, text))),
        h('span', { className: 'sn_hint' }, t(hintKey)));

      // ── 小窗与快捷键：下拉选项 + 伴生进程状态 ──
      //
      // 会话列表来自 `/status`（打开面板那一刻现取）。取不到时不能只显示空下拉 ——
      // 那看起来像"没有任何会话可绑"，而其实只是这一版的宿主没给列表。
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const boundId = String(draft.talkSession ?? 'follow');
      const sessionOptions = [
        ['follow', t('talk.follow')],
        ...sessions.map((s) => {
          // 名字优先：光给 id 前缀谁认得出哪个是哪个。真没名字（还没起标题的新会话）
          // 才退回 id 前缀，至少还能对上眼。
          const label = s.title ? String(s.title) : `${String(s.id).slice(0, 8)}…`;
          return [s.id, s.active ? `${label}${t('talk.current')}` : label];
        }),
      ];
      /**
       * 绑的那个会话可能已经关了，也可能这次的列表根本没取到。
       *
       * 这时**必须把它补进选项**：不补的话下拉框会落到第一项「不绑定」上 ——
       * 用户只是来改个快捷键，一保存就把绑定悄悄取消了，而且看不出来为什么。
       */
      if (boundId !== 'follow' && !sessionOptions.some(([value]) => value === boundId)) {
        sessionOptions.push([boundId, `${boundId.slice(0, 8)}… ${t('talk.missing')}`]);
      }
      const boundLabel = (() => {
        const hit = sessionOptions.find(([value]) => String(value) === boundId);
        if (hit) return hit[1];
        return boundId === 'follow' ? t('talk.follow') : `${boundId.slice(0, 8)}…`;
      })();
      // 会话多的时候（几百个）光靠滚动是找不着东西的 —— 面板顶上给个过滤框，
      // 标题和 id 都参与匹配，粘一段 id 也能定位。
      const pickRows = (() => {
        const q = pickQuery.trim().toLowerCase();
        if (!q) return sessionOptions;
        return sessionOptions.filter(([value, label]) =>
          String(label).toLowerCase().includes(q) || String(value).toLowerCase().includes(q));
      })();

      const comp = data.companion ?? null;
      const companionStatus = (() => {
        const status = comp?.status ?? 'unknown';
        if (status === 'running') return t('talk.companion.running');
        if (status === 'off') return t('talk.companion.off');
        if (status === 'unsupported') return t('talk.companion.unsupported');
        if (status === 'starting') return t('state.loading');
        return `${t('talk.companion.bad')}：${comp?.reason ?? '未知'}`;
      })();

      // ── 转写服务：asr.json ──
      // 放在「常用」**下面**：先看"用哪个"，再看"那个服务的细节"。顶在最上面会让
      // 人以为这是在替换宿主自带的转写 —— 它只是备选，选「只用宿主的」时整块收起。
      const localCard = data.local && localDraft && shouldShowLocal(draft.prefer)
        ? h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' },
            h('span', { className: 'sn_cardname' }, t('local.title')),
            h('span', { className: 'sn_green' }, t('local.instant'))),
          h('p', { className: 'sn_note', style: { margin: '0 0 10px' } }, t('local.sub')),
          h('div', { className: 'sn_mono', style: { marginBottom: '10px' } }, data.local.path),
          !data.local.exists ? h('div', { className: 'sn_hint', style: { marginBottom: '10px' } }, t('local.empty')) : null,
          h('div', { className: 'sn_grid' },
            localSelect('api', 'local.api', 'local.api.hint', [
              ['openai-audio', t('local.api.openai')],
              ['chat-audio', t('local.api.chat')],
            ]),
            localField('baseUrl', 'local.baseUrl', 'local.baseUrl.hint', { type: 'text', placeholder: t('local.baseUrl.ph') }),
            localField('model', 'local.model', 'local.model.hint', { type: 'text' }),
            localField('language', 'local.language', 'local.language.hint', { type: 'text' }),
            localField('key', 'local.key', 'local.key.hint', {
              type: 'password',
              autoComplete: 'off',
              placeholder: data.local.hasKey ? t('local.key.keep') : t('local.key.ph'),
            })),

          data.local.manage ? h('div', { className: 'sn_hint', style: { marginTop: '8px' } }, t('local.manage')) : null,
          data.local.envKeys && data.local.envKeys.length > 0
            ? h('div', { className: 'sn_box warn', style: { marginTop: '10px' } },
              `${t('local.env')}：${data.local.envKeys.join('、')}`)
            : null,

          localRejected.length > 0
            ? h('div', { className: 'sn_box bad', style: { marginTop: '10px' } },
              t('err.rejected'),
              h('ul', {}, localRejected.map((line, i) => h('li', { key: i }, line))))
            : null,

          h('div', { className: 'sn_row', style: { marginTop: '10px' } },
            localAt > 0 ? h('span', { className: 'sn_ok' }, t('state.savedLocal')) : null,
            localAt < 0 ? h('span', { className: 'sn_note' }, t('state.nosave')) : null),

          h('details', { className: 'sn_det', style: { marginTop: '10px' } },
            h('summary', {}, t('local.sample')),
            h('pre', { className: 'sn_pre' }, t('local.sample.body'))))
        : null;

      return h('div', { className: 'sn_root' },
        h('div', { className: 'sn_hero' },
          h('h2', { className: 'sn_title' }, t('title')),
          h('p', { className: 'sn_sub' }, t('sub')),
          h('div', { className: 'sn_mono' }, `${t('hint.path')}：${data.path}`)),

        data.warnings.length > 0
          ? h('div', { className: 'sn_box warn', role: 'status' },
            t('warn.title'),
            h('ul', {}, data.warnings.map((line, i) => h('li', { key: i }, line))))
          : null,

        h('div', { className: 'sn_restart' }, t('hint.restart')),

        // ── 悬浮窗样式 ──
        // 放在「常用」上面：它是这一页唯一"改完立刻能看见"的东西，也最常被调
        h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' },
            h('span', { className: 'sn_cardname' }, t('win.title')),
            h('span', { className: 'sn_green' }, t('instant.note'))),
          h('p', { className: 'sn_note', style: { margin: 0 } }, t('win.sub')),
          h('div', { className: 'sn_grid' },
            h('label', { className: 'sn_field' },
              h('span', { className: 'sn_label' }, t('win.style')),
              h('select', {
                className: 'sn_select',
                value: windowStyle || 'auto',
                onChange: e => { void applyWindow({ style: e.target.value }); },
              }, ['auto', 'live', 'frost', 'solid'].map(value =>
                h('option', { key: value, value }, t('win.style.' + value)))),
              h('span', { className: 'sn_hint' }, t('win.style.hint')))),
          // 大窗气泡颜色（和小窗那套互不相通，各存各的键）
          h('div', { className: 'sn_grid' },
            h('div', { className: 'sn_field' },
              h('span', { className: 'sn_label' }, t('win.bubbleColor')),
              h('div', { className: 'sn_swatches' },
                h('label', {
                  className: 'sn_ccur',
                  style: { background: String(uiValue('bigBubbleColor') || '#07111d') },
                  title: String(uiValue('bigBubbleColor') || ''),
                },
                h('input', {
                  type: 'color',
                  value: String(uiValue('bigBubbleColor') || '#07111d'),
                  onChange: e => setUi('bigBubbleColor', e.target.value),
                })),
                ['#101a26', '#1b2b3d', '#2a3a4e', '#3d3226', '#2b2233', '#1d3329']
                  .map(col => h('button', {
                    key: col,
                    type: 'button',
                    className: `sn_sw${String(uiValue('bigBubbleColor') || '').toLowerCase() === col ? ' on' : ''}`,
                    style: { background: col },
                    title: col,
                    onClick: () => setUi('bigBubbleColor', col),
                  }))))),
          data.window && data.window.path
            ? h('div', { className: 'sn_mono' }, `${t('win.path')}：${data.window.path}`)
            : null,
          // 这一行**始终占位**：只在应用后变可见，避免设置页高度跳动（用户实报）
          h('span', { className: 'sn_ok', role: 'status',
            style: { minHeight: '1.5em', display: 'block',
                     visibility: windowAt > 0 ? 'visible' : 'hidden' } },
            t('win.applied'))),

        // ── 气泡与文字 ──
        h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' },
            h('span', { className: 'sn_cardname' }, t('bub.title')),
            h('span', { className: 'sn_green' }, t('instant.note'))),
          h('p', { className: 'sn_note', style: { margin: 0 } }, t('bub.sub')),

          // 预览：用当前的气泡色/文字色/字号/字重画一条样例气泡
          h('div', { className: 'sn_preview' },
            h('div', {
              className: 'sn_prevbub',
              style: {
                background: String(uiValue('bubbleColor') || '#07111d'),
                background: `color-mix(in srgb, ${String(uiValue('bubbleColor') || '#07111d')} ${Math.round(Math.max(0.25, Number(uiValue('bubbleOpacity') ?? 1)) * 100)}%, transparent)`,
                color: String(uiValue('fontColor') || '#edf6ff'),
                fontWeight: uiValue('fontBold') ? 700 : 400,
                fontSize: `${Number(uiValue('fontSize') || 11) * 1.15}px`,
                fontFamily: String(uiValue('fontFamily') || 'Microsoft YaHei UI'),
              },
            }, '预览：气泡和文字现在长这样')),

          // 气泡底色 + 透明度（只调气泡底板，不动文字）
          h('div', { className: 'sn_grid' },
            h('div', { className: 'sn_field' },
              h('span', { className: 'sn_label' }, t('bub.bubbleColor')),
              h('div', { className: 'sn_swatches' },
                // 当前气泡颜色块：点它弹系统颜色对话框
                h('label', {
                  className: 'sn_ccur',
                  style: { background: String(uiValue('bubbleColor') || '#101a26') },
                  title: String(uiValue('bubbleColor') || ''),
                },
                h('input', {
                  type: 'color',
                  value: String(uiValue('bubbleColor') || '#101a26'),
                  onChange: e => setUi('bubbleColor', e.target.value),
                })),
                ['#101a26', '#1b2b3d', '#2a3a4e', '#3d3226', '#2b2233', '#1d3329']
                  .map(col => h('button', {
                    key: col,
                    type: 'button',
                    className: `sn_sw${String(uiValue('bubbleColor') || '').toLowerCase() === col ? ' on' : ''}`,
                    style: { background: col },
                    title: col,
                    onClick: () => setUi('bubbleColor', col),
                  })))),
            h('label', { className: 'sn_field' },
              h('span', { className: 'sn_label' },
                `${t('bub.bubbleOpacity')} · ${Math.round(uiValue('bubbleOpacity') * 100)}%`),
              h('input', {
                className: 'sn_range', type: 'range', min: 0, max: 100, step: 1,
                value: Math.round(uiValue('bubbleOpacity') * 100),
                onChange: e => setUi('bubbleOpacity', Number(e.target.value) / 100),
              }))),

          h('div', { className: 'sn_grid' },
            h('label', { className: 'sn_field' },
              h('span', { className: 'sn_label' }, t('bub.stay')),
              h('input', {
                className: 'sn_input', type: 'number', min: 0, max: 120, step: 1,
                value: String(uiValue('bubbleStay')),
                onChange: e => setUi('bubbleStay', Number(e.target.value)),
              }),
              h('span', { className: 'sn_unit' }, 's')),
            h('label', { className: 'sn_field' },
              h('span', { className: 'sn_label' }, t('bub.max')),
              h('input', {
                className: 'sn_input', type: 'number', min: 1, max: 3, step: 1,
                value: String(uiValue('bubbleMax')),
                onChange: e => setUi('bubbleMax', Number(e.target.value)),
              }))),
          h('span', { className: 'sn_hint' }, `${t('bub.hint.stay')} ${t('bub.hint.max')}`),

          h('div', { className: 'sn_grid' },
            h('label', { className: 'sn_check', key: 'autoShrink' },
              h('input', {
                type: 'checkbox',
                checked: uiValue('autoShrink') === true,
                onChange: e => setUi('autoShrink', e.target.checked),
              }),
              h('span', {}, t('bub.autoShrink'))),
            h('label', { className: 'sn_field' },
              h('span', { className: 'sn_label' }, t('bub.shrinkAfter')),
              h('input', {
                className: 'sn_input', type: 'number', min: 3, max: 600, step: 1,
                value: String(uiValue('shrinkAfter')),
                onChange: e => setUi('shrinkAfter', Number(e.target.value)),
              }),
              h('span', { className: 'sn_unit' }, 's'))),
          h('span', { className: 'sn_hint sn_warnbig' }, t('bub.hint.auto'))),

        // ── 文字样式 ──
        h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' },
            h('span', { className: 'sn_cardname' }, t('font.title')),
            h('span', { className: 'sn_green' }, t('instant.note'))),
          h('p', { className: 'sn_note', style: { margin: 0 } }, t('font.sub')),
          h('div', { className: 'sn_grid sn_fontbar' },
            h('button', {
              type: 'button',
              className: `sn_fbtn${uiValue('fontBold') ? ' on' : ''}`,
              title: t('bub.fontBold'),
              onClick: () => setUi('fontBold', !uiValue('fontBold')),
            }, 'B'),
            // 字体：input + datalist —— 浏览器原生就带「下拉 + 输入搜索」
            h('input', {
              className: 'sn_select sn_fsel',
              list: 'sn-font-list',
              placeholder: t('bub.fontFamily.ph'),
              value: String(uiValue('fontFamily') || ''),
              onChange: e => setUi('fontFamily', e.target.value),
            }),
            h('datalist', { id: 'sn-font-list' },
              ['', 'Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'SimSun', '宋体', 'NSimSun',
               'SimHei', '黑体', 'KaiTi', '楷体', 'FangSong', '仿宋', 'STKaiti', 'STSong',
               'DengXian', '等线', 'Microsoft JhengHei', 'PMingLiU', 'MingLiU',
               'Segoe UI', 'Tahoma', 'Arial', 'Arial Black', 'Verdana', 'Calibri',
               'Cambria', 'Georgia', 'Times New Roman', 'Courier New', 'Consolas',
               'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'Fira Code',
               'Source Han Sans SC', 'Noto Sans SC', 'Noto Serif SC', 'HarmonyOS Sans SC',
               'Alibaba PuHuiTi', '思源黑体', 'LXGW WenKai', '霞鹜文楷']
                .map(v => h('option', { key: v, value: v }))),
            h('select', {
              className: 'sn_select sn_fsize',
              value: String(uiValue('fontSize')),
              onChange: e => setUi('fontSize', Number(e.target.value)),
            }, Array.from({ length: 18 }, (_, i) => 9 + i)
              .map(n => h('option', { key: n, value: n }, String(n)))),
            h('div', { className: 'sn_swatches' },
              // 当前颜色块：点它弹系统颜色对话框，和 Windows 工具条一样
              h('label', {
                className: 'sn_ccur',
                style: { background: String(uiValue('fontColor') || '#edf6ff') },
                title: String(uiValue('fontColor') || ''),
              },
              h('input', {
                type: 'color',
                value: String(uiValue('fontColor') || '#edf6ff'),
                onChange: e => setUi('fontColor', e.target.value),
              })),
              ['#edf6ff', '#9fd8ff', '#ffffff', '#ffd479', '#ffb4b4',
               '#5fdc9a', '#c9b6ff', '#ff8ad8', '#a0ffef', '#fff3a0'].map(col =>
                h('button', {
                  key: col,
                  type: 'button',
                  className: `sn_sw${String(uiValue('fontColor') || '').toLowerCase() === col.toLowerCase() ? ' on' : ''}`,
                  style: { background: col },
                  title: col,
                  onClick: () => setUi('fontColor', col),
                })))),
          h('span', { className: 'sn_hint' }, t('bub.hint.font'))),

        
// ── 小窗与快捷键 ──
        // 紧跟在悬浮窗卡片后面：两张都是"改完立刻生效"的，也都是关于"这个小窗本身"的。
        h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' },
            h('span', { className: 'sn_cardname' }, t('talk.title')),
            h('span', { className: 'sn_green' }, t('instant.note'))),

          h('div', { className: 'sn_field', key: 'talkSession' },
            h('span', { className: 'sn_label' }, t('talk.session')),
            h('div', { className: 'sn_pick', ref: pickBox },
              h('button', {
                type: 'button',
                className: 'sn_pickbtn',
                title: t('talk.pick'),
                onClick: () => {
                  setPickOpen(v => !v);
                  setPickQuery('');
                },
              },
              h('span', { className: 'sn_picktitle' }, boundLabel),
              // 缩成前 8 位，但 `title` 挂完整 id —— 鼠标停上去就能核对是哪一个
              boundId === 'follow'
                ? null
                : h('span', { className: 'sn_pickid', title: boundId }, boundId.slice(0, 8)),
              h('span', { className: 'sn_caret' }, pickOpen ? '▴' : '▾')),

              pickOpen ? h('div', { className: 'sn_panel' },
                sessionOptions.length > 6
                  ? h('input', {
                    className: 'sn_filter',
                    value: pickQuery,
                    placeholder: t('talk.search'),
                    onChange: e => setPickQuery(e.target.value),
                  })
                  : null,
                h('div', { className: 'sn_list' },
                  pickRows.length === 0
                    ? h('div', { className: 'sn_none' }, t('talk.empty'))
                    : pickRows.map(([value, text]) => h('button', {
                      type: 'button',
                      key: String(value),
                      className: `sn_opt${String(value) === boundId ? ' on' : ''}`,
                      onClick: () => {
                        set('talkSession', value);
                        setPickOpen(false);
                        setPickQuery('');
                      },
                    },
                    h('span', { className: 'sn_opttitle' }, text),
                    String(value) === 'follow'
                      ? null
                      : h('span', { className: 'sn_optid', title: String(value) }, String(value).slice(0, 8)))))) : null),
            sessions.length === 0
              ? h('span', { className: 'sn_hint' },
                data.sessionsNote ? `${t('talk.empty')}（${data.sessionsNote}）` : t('talk.empty'))
              : null,
            sessions.length > 0 ? h('span', { className: 'sn_hint' }, t('talk.idhint')) : null),

          h('div', { className: 'sn_field', key: 'hotkey' },
            h('span', { className: 'sn_label' }, t('talk.hotkey')),
            h('div', { className: 'sn_row' },
              h('button', {
                type: 'button',
                className: `sn_cap${capturing && captureTarget === 'hotkey' ? ' on' : ''}${captureBad && captureTarget === 'hotkey' ? ' bad' : ''}`,
                onClick: () => {
                  // 点框子 = 「就这样吧」：攒着的键够用就直接定稿
                  const pending = captureKeys.current;
                  const usable = capturing && captureTarget === 'hotkey' && pending.length > 0
                    && pending.some(k => !MOD_ORDER.includes(k));
                  clearCaptureTimer();
                  captureKeys.current = [];
                  setCapturePreview('');
                  if (usable) {
                    setCapturing(false);
                    setCaptureBad('');
                    set(captureTarget, pending);
                    return;
                  }
                  setCaptureTarget('hotkey');
                  setCapturing(v => !v);
                },
              },
              capturing && captureTarget === 'hotkey'
                ? (capturePreview || t('talk.hotkey.rec'))
                : (hotkeyText(draft.hotkey) || t('talk.hotkey.unset'))),
              hotkeyText(draft.hotkey)
                ? h('button', {
                  type: 'button',
                  className: 'sn_btn',
                  onClick: () => {
                    clearCaptureTimer();
                    captureKeys.current = [];
                    set('hotkey', []);
                    setCapturing(false);
                    setCapturePreview('');
                  },
                }, t('talk.hotkey.reset'))
                : null),
            h('span', { className: 'sn_hint' }, t('talk.hotkey.hint'))),

          // 麦克风快捷键：和上面那条共用同一套录制，只是写进 micHotkey。
          // 相邻摆放是有意的 —— 都是"按下去就发生"的全局键，分开放用户要来回找。
          h('div', { className: 'sn_field', key: 'micHotkey' },
            h('span', { className: 'sn_label' }, t('talk.micHotkey')),
            h('div', { className: 'sn_row' },
              h('button', {
                type: 'button',
                className: `sn_cap${capturing && captureTarget === 'micHotkey' ? ' on' : ''}${captureBad && captureTarget === 'micHotkey' ? ' bad' : ''}`,
                onClick: () => {
                  const pending = captureKeys.current;
                  const usable = capturing && captureTarget === 'micHotkey' && pending.length > 0
                    && pending.some(k => !MOD_ORDER.includes(k));
                  clearCaptureTimer();
                  captureKeys.current = [];
                  setCapturePreview('');
                  if (usable) {
                    setCapturing(false);
                    setCaptureBad('');
                    set(captureTarget, pending);
                    return;
                  }
                  setCaptureTarget('micHotkey');
                  setCapturing(v => !v);
                },
              },
              capturing && captureTarget === 'micHotkey'
                ? (capturePreview || t('talk.hotkey.rec'))
                : (hotkeyText(draft.micHotkey) || t('talk.hotkey.unset'))),
              hotkeyText(draft.micHotkey)
                ? h('button', {
                  type: 'button',
                  className: 'sn_btn',
                  onClick: () => {
                    clearCaptureTimer();
                    captureKeys.current = [];
                    set('micHotkey', []);
                    setCapturing(false);
                    setCapturePreview('');
                  },
                }, t('talk.hotkey.reset'))
                : null),
            h('span', { className: 'sn_hint' }, t('talk.micHotkey.hint'))),

          // 输入条快捷键：第三条，同样是"按下去就发生"的全局键，放在一起录。
          h('div', { className: 'sn_field', key: 'inputHotkey' },
            h('span', { className: 'sn_label' }, t('talk.inputHotkey')),
            h('div', { className: 'sn_row' },
              h('button', {
                type: 'button',
                className: `sn_cap${capturing && captureTarget === 'inputHotkey' ? ' on' : ''}${captureBad && captureTarget === 'inputHotkey' ? ' bad' : ''}`,
                onClick: () => {
                  const pending = captureKeys.current;
                  const usable = capturing && captureTarget === 'inputHotkey' && pending.length > 0
                    && pending.some(k => !MOD_ORDER.includes(k));
                  clearCaptureTimer();
                  captureKeys.current = [];
                  setCapturePreview('');
                  if (usable) {
                    setCapturing(false);
                    setCaptureBad('');
                    set(captureTarget, pending);
                    return;
                  }
                  setCaptureTarget('inputHotkey');
                  setCapturing(v => !v);
                },
              },
              capturing && captureTarget === 'inputHotkey'
                ? (capturePreview || t('talk.hotkey.rec'))
                : (hotkeyText(draft.inputHotkey) || t('talk.hotkey.unset'))),
              h('button', {
                type: 'button',
                className: 'sn_btn',
                disabled: !hotkeyText(draft.inputHotkey),
                onClick: () => {
                  clearCaptureTimer();
                  captureKeys.current = [];
                  set('inputHotkey', []);
                  setCapturing(false);
                  setCapturePreview('');
                },
              }, t('talk.hotkey.reset'))),
            h('span', { className: 'sn_hint' }, t('talk.inputHotkey.hint'))),

          // 两条焦点开关：上面那条关着时下面这条置灰而不是藏起来 ——
          // 藏起来的话用户不知道"为什么我切走它不回来"，置灰至少能看出因果

          // 「自动续看」不再放设置页：用户要求直接从悬浮窗标题栏那格开关
          // （点「焦点·DSH」，绿=开、红=关）。这里只说一声，免得他找不到。

          // 第三条：按快捷键时拉不拉窗。它和上面两条不是一回事（那两条管"什么时候停"，
          // 这条管"开的时候要不要在屏幕上出现"），所以不加缩进层级，平铺着排。
          // 两个开关并排：开始陪看拉窗 / 暂停陪看发一次图
          h('div', { className: 'sn_grid' },
            h('label', { className: 'sn_check', key: 'hotkeyWindow' },
              h('input', {
                type: 'checkbox',
                checked: draft.hotkeyWindow !== false,
                onChange: e => set('hotkeyWindow', e.target.checked),
              }),
              h('span', {}, t('talk.hotkeyWindow'))),
            h('label', { className: 'sn_check', key: 'pauseSignal' },
              h('input', {
                type: 'checkbox',
                checked: draft.pauseSignal === true,
                onChange: e => set('pauseSignal', e.target.checked),
              }),
              h('span', {}, t('talk.pauseSignal')))),

          // 跟随 DSH 启动自动开始陪看（只影响下一次启动）
          h('div', { className: 'sn_grid' },
            h('label', { className: 'sn_check', key: 'autoWatchOnStart' },
              h('input', {
                type: 'checkbox',
                checked: draft.autoWatchOnStart === true,
                onChange: e => set('autoWatchOnStart', e.target.checked),
              }),
              h('span', {}, t('talk.autoWatch'))),
            h('span', { className: 'sn_hint' }, t('talk.autoWatch.hint'))),

          h('div', { className: 'sn_row', style: { marginTop: '2px' } },
            h('span', { className: 'sn_mono' }, `${t('talk.companion')}：${companionStatus}`),
            comp && comp.canHotkey === false
              ? h('span', { className: 'sn_hint' }, t('talk.companion.noFocus'))
              : null),
          comp && comp.status === 'error'
            ? h('div', { className: 'sn_box warn', role: 'status' }, `${t('talk.companion.bad')}：${comp.reason ?? '未知'}`)
            : null),

        // ── 常用 ──
        h('div', { className: 'sn_card' },
          h('div', { className: 'sn_cardhd' },
            h('span', { className: 'sn_cardname' }, t('sec.common')),
            h('span', { className: 'sn_red' }, t('restart.note'))),
          h('div', { className: 'sn_grid' },
            select('prefer', 'field.prefer', 'field.prefer.hint', [
              ['auto', t('prefer.auto')],
              ['host', t('prefer.host')],
              ['local', t('prefer.local')],
            ]),
            select('defaultPace', 'field.pace', 'field.pace.hint', [
              ['calm', t('pace.calm')],
              ['normal', t('pace.normal')],
              ['dense', t('pace.dense')],
              ['game-economic', t('pace.game-economic')],
            ]),
            select('wakeBatch', 'field.batch', 'field.batch.hint', [
              [1, t('batch.1')],
              [2, t('batch.2')],
              [3, t('batch.3')],
              [4, t('batch.4')],
            ]),
            field('idleStopMin', 'field.idleStop', 'field.idleStop.hint', { min: 0, max: 1440, step: 1 }),
            select('speechPacing', 'field.pacing', 'field.pacing.hint', [
              [true, t('pacing.follow')],
              ['guard', t('pacing.guard')],
              [false, t('pacing.off')],
            ]),
            field('silence', 'field.silence', 'field.silence.hint', { min: 0.15, max: 1.5, step: 0.05 }),
            field('maxSeg', 'field.maxSeg', 'field.maxSeg.hint', { min: 0.8, max: 15, step: 0.1 }))),

        localCard,

        // ── 高级 ──
        h('details', { className: 'sn_det sn_card' },
          h('summary', {},
            h('span', {}, t('sec.advanced')),
            h('span', { className: 'sn_red', style: { marginLeft: '10px' } }, t('restart.note'))),
          h('div', { className: 'sn_grid', style: { marginTop: '12px' } },
            select('tierStyle', 'field.tierStyle', 'field.tierStyle.hint', [
              ['standard', t('tier.standard')],
              ['native', t('tier.native')],
              ['full', t('tier.full')],
              ['compact', t('tier.compact')],
              ['custom', t('tier.custom')],
            ]),
            select('tierMode', 'field.tierMode', 'field.tierMode.hint', [
              ['density', t('mode.density')],
              ['weight', t('mode.weight')],
            ]),
            select('tierCurve', 'field.tierCurve', 'field.tierCurve.hint', [
              ['docx', t('curve.docx')],
              ['perceptual', t('curve.perceptual')],
              ['custom', t('curve.custom')],
            ]),
            field('maxAutonomousWakes', 'field.wakes', 'field.wakes.hint', { min: 1, max: 200, step: 1 }),
            field('imageTrigger', 'field.imageTrigger', 'field.imageTrigger.hint', { min: 0, max: 2000, step: 10 }),
            field('imageKeep', 'field.imageKeep', 'field.imageKeep.hint', { min: 0, max: 2000, step: 10 }),
            field('liveMin', 'field.liveMin', 'field.liveMin.hint', { min: 0.8, max: 6, step: 0.1 }),
            field('liveStep', 'field.liveStep', 'field.liveStep.hint', { min: 0.4, max: 4, step: 0.1 }),
            field('pollMs', 'field.pollMs', 'field.pollMs.hint', { min: 50, max: 1000, step: 10 })),

          /**
           * 选了「自定义」才展开这 8 个下拉。
           *
           * 左边是**算出来的档位**，右边选它实际落到哪一档 —— 不是"把第 i 格画多大"，
           * 是"这一档的帧应该长多大"。两者容易搞混，所以第一列写 `i →` 而不是"第 i 档"。
           */
          draft.tierStyle === 'custom'
            ? h('div', { className: 'sn_grid', style: { marginTop: '12px' } },
              h('span', { className: 'sn_label', style: { gridColumn: '1 / -1' } }, t('field.tierMap')),
              /**
               * 一键填满：把八项一起改成同一个档。
               *
               * 这就是"每帧固定这么大"的做法 —— 八项都指向同一档时，密度算出来的档位
               * 被整表吃掉，节奏怎么改都不影响尺寸。**不做成独立选项**：它和逐档自定义
               * 是同一件事，多一个概念只会让人以为还有别的能力。
               */
              h('label', { className: 'sn_field', key: 'fill', style: { gridColumn: '1 / -1' } },
                h('span', { className: 'sn_label' }, t('field.fillTierMap')),
                h('select', {
                  className: 'sn_select',
                  defaultValue: '',
                  onChange: (e) => {
                    const v = Number(e.target.value);
                    if (v >= 1 && v <= 8) set('tierMap', Array.from({ length: 8 }, () => v));
                    e.target.selectedIndex = 0;
                  },
                },
                h('option', { value: '' }, t('field.fillTierMap.pick')),
                [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { key: n, value: String(n) }, `${n} 档`))),
                h('span', { className: 'sn_hint' }, t('field.fillTierMap.hint'))),
              [0, 1, 2, 3, 4, 5, 6, 7].map((i) => h('label', { className: 'sn_field', key: `tm${i}` },
                h('span', { className: 'sn_label' }, `${i + 1} →`),
                h('select', {
                  className: 'sn_select',
                  value: String(draft.tierMap?.[i] ?? i + 1),
                  onChange: (e) => setTierMap(i, e.target.value),
                }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { key: n, value: String(n) }, String(n)))))))
            : null,
          draft.tierStyle === 'custom'
            ? h('span', { className: 'sn_hint' }, t('field.tierMap.hint'))
            : null,
          /**
           * 七道阈值自己填。**只在选「自定义」时出现** —— 选 docx / 感知时那套数字是
           * 代码定的，露出来只会让人以为改得动。
           *
           * 顺序有意义：第 i 个是"多密算第 i+1 档"，必须严格递增。前端不拦，
           * 交给 `tuning.js` 统一判（那边拒了会把原话显示在下面）。
           */
          draft.tierCurve === 'custom'
            ? h('div', { className: 'sn_grid', style: { marginTop: '12px' } },
              h('span', { className: 'sn_label', style: { gridColumn: '1 / -1' } }, t('field.tierThresholds')),
              [0, 1, 2, 3, 4, 5, 6].map((i) => h('label', { className: 'sn_field', key: `th${i}` },
                h('span', { className: 'sn_label' }, `第 ${i + 1} 道`),
                h('input', {
                  className: 'sn_input',
                  type: 'number',
                  step: '0.01',
                  min: '0.01',
                  value: String(draft.tierThresholds?.[i] ?? ''),
                  onChange: (e) => setThreshold(i, e.target.value),
                }))),
              h('span', { className: 'sn_hint', style: { gridColumn: '1 / -1' } }, t('field.tierThresholds.hint')))
            : null,
          h('label', { className: 'sn_check', style: { marginTop: '12px' } },
            h('input', {
              type: 'checkbox',
              checked: draft.live === true,
              onChange: e => set('live', e.target.checked),
            }),
            h('span', {}, t('field.live'))),
          h('span', { className: 'sn_hint' }, t('field.live.hint'))),

        // ── 保存 ──
        rejected.length > 0
          ? h('div', { className: 'sn_box bad', role: 'alert' },
            t('err.rejected'),
            h('ul', {}, rejected.map((line, i) => h('li', { key: i }, line))))
          : null,

        error !== ''
          ? h('div', { className: 'sn_box bad', role: 'alert' }, `${t('err.save')}：${error}`)
          : null,

        h('div', { className: 'sn_row' },
          h('button', { className: 'sn_btn', onClick: load, disabled: busy }, t('state.reload')),
          savedAt > 0 ? h('span', { className: 'sn_ok', role: 'status' }, t('state.saved')) : null),

        h('div', { className: 'sn_note' }, t('hint.origin')));
    }

    // ── 接进 shell ────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'her-company');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'her-company: styles');

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'see-now',
        order: 43,
        label: () => t('nav'),
        locale: NS,
      }, () => h(SettingsPage)));

      // 导航图标：眼睛在后方，正上方压一个纯白色十字星（两个长梭形垂直相叠），
      // 梭形尖端超出眼睛轮廓。契约：组件收到 {size（像素）, active}，外壳负责按钮/标签/装饰容器。
      const EyeIcon = (props) => {
        const s = Math.max(12, Number(props?.size) || 18);
        const eye = props?.active ? '#9cc7ff' : 'currentColor';
        return h('svg', {
          width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          'aria-hidden': true, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        },
        // 眼形外框（在星星后面）
        h('path', {
          d: 'M2.8 12S6.1 5.6 12 5.6 21.2 12 21.2 12 17.9 18.4 12 18.4 2.8 12 2.8 12Z',
          stroke: eye, 'stroke-width': '1.6',
        }),
        // 虹膜（也在星星后面，会被星心遮住）
        h('circle', { cx: 12, cy: 12, r: 3.2, stroke: eye, 'stroke-width': '1.3' }),
        // 十字星：两个白色长梭形，尖端锐利，上下/左右都超出眼睛
        h('path', {
          d: 'M12 1.2 C14.6 7.0 14.6 17.0 12 22.8 C9.4 17.0 9.4 7.0 12 1.2 Z',
          fill: '#ffffff',
        }),
        h('path', {
          d: 'M1.2 12 C7.0 9.4 17.0 9.4 22.8 12 C17.0 14.6 7.0 14.6 1.2 12 Z',
          fill: '#ffffff',
        }));
      };
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: 'see-now',
        order: 43,
        label: () => t('nav'),
      }, (props) => h(EyeIcon, props)));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'her-company';
    exports.__test = { draftOf, mergeValues, patchOf, num, TEXT, localDraftOf, localPatchOf, shouldShowLocal,
      hotkeyText, keyNameOf };
    return module.exports;
  },
});
