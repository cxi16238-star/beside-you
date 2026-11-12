// 把 beside-you 推到 GitHub，并发一个带 tgz 附件的 Release。
//
// 用法：node scripts/publish-github.mjs --token github_pat_xxx [--repo beside-you] [--private]
//
// 为什么是 .mjs 不是 .ps1：这台机器 PowerShell 5.1 的执行策略 + here-string 解析
// 都不配合，中文字面量过一遍 shell 还会乱码。Node 里 fetch + execFile 一次到底。
//
// token 只出现在 push 那一条命令的 URL 里，推完立刻把 remote 改回干净地址。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const API = 'https://api.github.com';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const token = arg('token');
if (!token || token === true) {
  console.error('用法：node scripts/publish-github.mjs --token <PAT> [--repo <名字>] [--private]');
  process.exit(2);
}
const repoName = String(arg('repo', 'beside-you'));
const isPrivate = arg('private', false) === true;

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'beside-you',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function call(method, path, body, extra = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: { ...headers, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: HERE, encoding: 'utf8', stdio: opts.show ? 'inherit' : 'pipe' });
}

const pkgPath = join(HERE, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

const me = await call('GET', '/user');
if (!me.ok) {
  console.error(`token 用不了（HTTP ${me.status}）：${me.text.slice(0, 300)}`);
  process.exit(1);
}
const owner = me.json.login;
const full = `${owner}/${repoName}`;
console.log(`账号：${owner}`);

// 仓库：有就复用，没有就建
const existing = await call('GET', `/repos/${full}`);
if (existing.ok) {
  console.log(`仓库已存在：https://github.com/${full}`);
} else {
  const created = await call('POST', '/user/repos', {
    name: repoName,
    description: 'beside-you（带上她的眼睛）：DSH 屏幕陪看插件。核心图像技术来自 dsh-see-now；小窗绑定会话 / 全局快捷键 / 语音输入与播报 / 焦点暂停 / 气泡与玻璃悬浮窗',
    private: isPrivate,
    has_issues: true,
  });
  if (!created.ok) {
    console.error(`建仓库失败（HTTP ${created.status}）：${created.text.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`已建仓库：https://github.com/${full}`);
}

// package.json 里的仓库地址跟着实际 owner 走
const wantRepo = `git+https://github.com/${full}.git`;
if (pkg.repository?.url !== wantRepo || pkg.homepage !== `https://github.com/${full}`) {
  pkg.repository = { type: 'git', url: wantRepo };
  pkg.homepage = `https://github.com/${full}`;
  pkg.bugs = { url: `https://github.com/${full}/issues` };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log('package.json 已补 repository/homepage');
}

// 本地仓库：没有就建，有就把改动都提交上
if (!existsSync(join(HERE, '.git'))) {
  git(['init', '-q', '-b', 'main']);
  console.log('已 git init');
}
const ident = ['-c', 'user.name=beside-you', '-c', 'user.email=plus@localhost'];
git(['add', '-A']);
const staged = (() => {
  try { return git(['diff', '--cached', '--name-only']).trim(); } catch { return ''; }
})();
if (staged) {
  git([...ident, 'commit', '-q', '-m', `beside-you ${version}`]);
  console.log(`已提交 ${staged.split('\n').length} 个文件`);
} else {
  console.log('没有新改动需要提交');
}

// 推送。token 写在 URL 里，前缀不是 https://github.com/，所以不会被
// ~/.gitconfig 里那条 ghproxy 的 insteadOf 改写。
const auth = `https://x-access-token:${token}@github.com/${full}.git`;
try { git(['remote', 'remove', 'origin']); } catch { /* 没有 origin 正常 */ }
git(['remote', 'add', 'origin', auth]);
git(['push', '-u', 'origin', 'main', '--quiet'], { show: true });
git(['remote', 'set-url', 'origin', `https://github.com/${full}.git`]);
console.log(`已推送：https://github.com/${full}`);

// Release
const notes = [
  '**beside-you（带上她的眼睛）** —— `dsh-see-now` 的整包 fork，核心图像技术（采集 / 切点判定 / 拼图 / 档位）来自 [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)。装上就是这一版，**不要再装官方版** —— 两个包会抢同一个 `see_now` 工具。',
  '',
  '### 给 Agent 的须知',
  '',
  '- 用户有任务不明白、不理解、不知道怎么操作的内容时，**可以直接让 Agent 接管**（一步步带，或者它自己动手）',
  '- Agent 特别熟本插件的两条语音通道：**语音输入**（麦克风按钮：点按切换录音、长按说话）与 **`say` 播报**（唯一会被念出来、以气泡弹出的通道）—— 用户手忙不过来时用它',
  '',
  '### 比原版多的',
  '',
  '- **小窗交流绑定会话**：小窗里打的字投给谁、陪看叫醒谁、谁的回答进小窗。默认跟随当前会话，也可以钉死某一个（跨工作区可选）',
  '- **自定义快捷键（1~3 键）**：全局按一下就开/关陪看，不注册系统热键（`GetAsyncKeyState` 轮询），不会跟别的软件抢组合；另有麦克风、输入条两条快捷键',
  '- **DSH 一到前台就停陪看** + **被打断后自动续看**（按前台窗口的可执行文件路径判断焦点）',
  '- **跟随 DSH 启动自动开始陪看**（可选；优先绑定会话，其次最近活跃会话）',
  '- **暂停时发最后画面**：按开关 / 关浮窗 / 焦点判定停下来的那一刻，把最后一张画面和暂停原因一起发进会话（可选）',
  '- **小悬浮窗**：「—」不再缩到托盘，改成两条胶囊（静音/气泡/大窗/关闭/语音/文字六个圆按钮）；贴边吸附、3 秒没人碰自动半藏、鼠标一进来弹回',
  '- **两个圆形输入按钮**：语音、文字分开；点「字」展开文本条并**直接就能打字**（焦点自动给输入框）',
  '- **气泡队列**：最多 3 条、下新上老、超限替换、旧的向上渐隐、新的下方渐显；一条最多 150 字（超出「……」），右下角倒三角点开看全文；停留时长可调',
  '- **字体自定义**：字号 9~26、颜色、加粗、字体族',
  '- **三个独立透明度**：背景 / 气泡底板 / 文字，拖动时窗口实时跟着变',
  '- **自动缩成小悬浮窗**：静止 N 秒（3~3600）自己缩下去，鼠标停着或正在打字时不计时',
  '- **静音 + 垂直音量条**：鼠标移上去展开、**按下去就能拖**、离开自动收起；静音会写进给模型的提示里',
  '- **顶栏状态行**：`陪看中 · 焦点：DSH/别处 · 已开启/未开启恢复陪看`',
  '- **玻璃悬浮窗**：实时玻璃 / 静态磨砂 / 纯色三种外观，圆按钮玻璃垫片跟随位置',
  '- **配置热重载**：`~/.dsh/see-now.json` / `watch-window.json` 一变，几百毫秒内生效',
  '',
  '### 装法',
  '',
  '```bash',
  'dsh plugin --profile desktop remove dsh-see-now        # 先卸官方版',
  `dsh plugin --profile desktop add beside-you-${version}.tgz`,
  "# 然后重启 DSH：设置里多出「带上她的眼睛」这一页",
  '```',
  '',
  '小窗要 `pip install pillow numpy mss`；快捷键/焦点暂停要 Python 3.8+。',
  '',
  'Apache-2.0，`LICENSE` / `NOTICE` / `CREDITS.md` 原样保留。',
].join('\n');

let rel = await call('GET', `/repos/${full}/releases/tags/${tag}`);
if (rel.ok) {
  console.log(`Release 已存在：${rel.json.html_url}`);
} else {
  rel = await call('POST', `/repos/${full}/releases`, {
    tag_name: tag,
    name: `beside-you ${version}`,
    body: notes,
    draft: false,
    prerelease: false,
  });
  if (!rel.ok) {
    console.error(`发 Release 失败（HTTP ${rel.status}）：${rel.text.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`已发 Release：${rel.json.html_url}`);
}

const tgz = join(HERE, `beside-you-${version}.tgz`);
if (existsSync(tgz)) {
  const bytes = readFileSync(tgz);
  const res = await fetch(
    `https://uploads.github.com/repos/${full}/releases/${rel.json.id}/assets?name=${encodeURIComponent(basename(tgz))}`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/gzip' }, body: bytes },
  );
  if (!res.ok) {
    const t = await res.text();
    if (t.includes('already_exists')) console.log('附件已存在，跳过');
    else {
      console.error(`挂附件失败（HTTP ${res.status}）：${t.slice(0, 300)}`);
      process.exit(1);
    }
  } else {
    console.log(`已挂附件：${basename(tgz)}`);
  }
} else {
  console.log(`（没找到 ${tgz}，跳过附件）`);
}

console.log(`\n完成：https://github.com/${full}`);
