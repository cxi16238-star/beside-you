/**
 * `$DSH_HOME/asr.json` 的读写。see-now 与 storyboard 共用这一份文件：
 * storyboard 用它找转写服务做字幕，see-now 用它找听写服务做实时字幕。
 *
 * 与 `tuning.js` 的 `writeTuning` 有一处**关键**区别：`see-now.json` 是 see-now
 * 独占的，不认识的键可以整份拒；`asr.json` 不是 —— 别的插件会在里面放自己的键
 * （`manage` 就是 storyboard 用来拉起服务的），所以这里**必须原样保留不认识的键**，
 * 只动已知的那几个。写坏这一份，坏的是两个插件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASR_APIS } from './listen.js';

/** 面板能改的键。`manage` 刻意不在里面 —— 那是"怎么拉起服务"，属于部署侧。 */
export const ASR_WRITABLE_KEYS = Object.freeze(['api', 'baseUrl', 'model', 'language', 'key']);

/** `asr.json` 与 `see-now.json` 同目录：`tuningPath()` 就是 `$DSH_HOME/see-now.json`。 */
export function asrPath(tuningPath) {
  return join(dirname(tuningPath), 'asr.json');
}

function readRaw(path, readFile) {
  try {
    const j = JSON.parse(readFile(path, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/**
 * 给面板看的一份快照。**不返回 key 本身**，只说有没有 —— 密钥没有回传的必要，
 * 回传只会让它多走一遍浏览器内存和日志。
 */
export function readAsrConfig(path, { readFile = readFileSync } = {}) {
  const raw = readRaw(path, readFile);
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : '';
  return {
    path,
    exists: Boolean(baseUrl),
    api: ASR_APIS.includes(raw.api) ? raw.api : 'openai-audio',
    baseUrl,
    model: typeof raw.model === 'string' ? raw.model : '',
    language: typeof raw.language === 'string' ? raw.language : '',
    hasKey: typeof raw.key === 'string' && raw.key.length > 0,
    manage: Boolean(raw.manage && typeof raw.manage === 'object'),
  };
}

/**
 * 只改传进来的那几个键，其余原样写回。
 *
 * 三条规矩（和 `writeTuning` 一致）：
 * 1. 面板提交里出现未知键 → 整份拒，方便定位面板与后端的版本错位
 * 2. `baseUrl` / `key` 传空串 = **删掉这个键**。"没有 key" 与 "key 是空串"
 *    对下游是两件事（后者会发出一个空的 Authorization 头）
 * 3. 校验不过就整份不写 —— 不做"部分成功"，否则用户以为全改了
 */
export function writeAsrConfig(
  patch,
  { path, readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync } = {},
) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, path, rejected: ['没有收到要改的内容'] };
  }
  const unknown = Object.keys(patch).filter((k) => !ASR_WRITABLE_KEYS.includes(k));
  if (unknown.length) {
    return { ok: false, path, rejected: [`面板不认识这些字段：${unknown.join('、')}`] };
  }

  const out = { ...readRaw(path, readFile) };
  const rejected = [];

  for (const [k, v] of Object.entries(patch)) {
    if (k === 'api') {
      if (!ASR_APIS.includes(v)) rejected.push(`api 只能是 ${ASR_APIS.join(' / ')}`);
      else out.api = v;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    if (k === 'baseUrl' || k === 'key') {
      if (!s) {
        delete out[k];
        continue;
      }
      if (k === 'baseUrl') {
        let ok = false;
        try {
          const u = new URL(s);
          ok = u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          ok = false;
        }
        if (!ok) {
          rejected.push('baseUrl 得是 http:// 或 https:// 开头的地址');
          continue;
        }
      }
      out[k] = s;
      continue;
    }
    if (!s) {
      rejected.push(`${k} 不能为空`);
      continue;
    }
    out[k] = s;
  }

  if (rejected.length) return { ok: false, path, rejected };

  mkdir(dirname(path), { recursive: true });
  writeFile(path, `${JSON.stringify(out, null, 2)}\n`);
  return { ok: true, path, values: readAsrConfig(path, { readFile }) };
}
