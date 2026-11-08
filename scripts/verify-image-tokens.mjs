/**
 * verify-image-tokens.mjs — 拿**宿主自己的计费实现**给我方的 `imageTokens()` 打分。
 *
 * 从 `dsh-video-storyboard/scripts/verify-image-tokens.mjs` 搬来的。搬的理由：
 * see-now 的整个卖点是"省 token"，而这个包**所有**对外报出来的价钱
 * （`quality` 四档的 222/392/560/860）都出自 `src/tokens.js` 一处换算。
 * 那个公式是照抄宿主的（14px patch 对齐 → 42px 一格 → `rows×(cols+1)+2`），
 * 照抄的东西必须能对拍 —— 否则宿主升级一次（v41 → v42…）我们就在报假账，而且没人发现。
 *
 *   node scripts/verify-image-tokens.mjs          # 对拍，不一致就 exit 1
 *   DSH_LLM_DEEPSEEK_PATH=... node ...           # 直接指定宿主模块
 *
 * 找不到宿主包时**不算失败**（CI / 干净机器上没有 DSH），打印一行说明就退出 0。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { imageTokens } from '../src/tokens.js';

/** 四档常用尺寸（含音轨条后的真实画布）+ region 竖屏 + 地板/封顶附近 + 极端值 */
const SIZES = [
  [798, 462], [1050, 630], [1260, 756], [1596, 924],   // quality 四档（low 带音轨条）
  [798, 450], [462, 798], [300, 520],                  // 无条 / 竖屏 region
  [320, 180], [400, 225], [544, 544], [640, 360],      // 地板附近
  [1300, 1300], [1600, 900], [1920, 1080], [5000, 5000], // 封顶与超限
  [100, 56], [200, 113], [1, 1],                       // 极端
];

/** 在 npx 缓存里找一份能用的 dsh-llm-deepseek（有 deepSeekImageTokens 导出的第一个）。 */
function findHostModules() {
  if (process.env.DSH_LLM_DEEPSEEK_PATH) return process.env.DSH_LLM_DEEPSEEK_PATH;
  const roots = [];
  if (process.env.DSH_TOOLS_PATH) roots.push(process.env.DSH_TOOLS_PATH);
  if (process.env.LOCALAPPDATA) {
    const npx = join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
    if (existsSync(npx)) {
      for (const dir of readdirSync(npx)) roots.push(join(npx, dir, 'node_modules', '@deepseek-ai'));
    }
  }
  for (const root of roots) {
    const candidate = join(root, 'dsh-llm-deepseek', 'lib', 'index.js');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const hostPath = findHostModules();
if (!hostPath) {
  console.log('[verify-image-tokens] 没找到宿主的 dsh-llm-deepseek，跳过（这不是失败）。');
  console.log('  想跑的话：DSH_LLM_DEEPSEEK_PATH=<...>/dsh-llm-deepseek/lib/index.js node scripts/verify-image-tokens.mjs');
  process.exit(0);
}

const host = await import(`file://${hostPath.replace(/\\/g, '/')}`);
if (typeof host.deepSeekImageTokens !== 'function') {
  console.log(`[verify-image-tokens] ${hostPath} 里没有 deepSeekImageTokens，宿主的实现变了 —— 去读一遍再照抄。`);
  process.exit(2);
}

let bad = 0;
for (const [w, h] of SIZES) {
  const mine = imageTokens(w, h);
  const theirs = host.deepSeekImageTokens(w, h);
  if (mine !== theirs) {
    bad += 1;
    console.log(`DIFF ${w}x${h}  我方=${mine}  宿主=${theirs}`);
  }
}
console.log(bad === 0
  ? `[verify-image-tokens] ${SIZES.length} 组尺寸与宿主完全一致 ✅`
  : `[verify-image-tokens] ${bad} 组不一致 ❌ —— 把 tokens.js 的 gridTokens/对齐规则重新对一遍`);
process.exit(bad === 0 ? 0 : 1);
