/**
 * hotkeys.js — 组合键的**规范名**，以及把用户输入洗成规范名的那一层。
 *
 * 为什么需要一份"规范名"：
 *
 * 1. 同一个键在三个地方出现 —— 浏览器 `KeyboardEvent`（`Control` / `ArrowUp` /
 *    `Escape`）、`see-now.json` 里存的那份、以及 Python 侧的虚拟键码表。三边各有
 *    各的叫法，不先归一化，"设好了按下去没反应"就会变成最难查的一类 bug。
 * 2. `patchOf` 靠**逐项比较**算补丁。`['Ctrl','Alt','K']` 和 `['alt','ctrl','k']`
 *    在 JSON 里不相等，每次保存都会把这条又写一遍、并且让用户以为"我刚改过"。
 *    **顺序也必须定死**（修饰键在前、按固定次序），否则同一个组合有 6 种写法。
 *
 * 这一份是**唯一事实来源**：`tuning.js` 用它校验、`companion.js` 用它拼参数、
 * `client.js` 里那份拷贝只负责画界面（那个文件是独立打包的 web bundle，import
 * 不到宿主模块）。改这里的时候记得同步那边。
 *
 * @module src/hotkeys.js
 */

/** 修饰键的固定次序 —— 拼出来的名字永远是这个顺序。 */
export const MODIFIER_KEYS = Object.freeze(['Ctrl', 'Alt', 'Shift', 'Win']);

/**
 * 可以单独按、也可以和修饰键组合的"普通键"。
 *
 * 只收**跨键盘布局稳定**的那批：字母、数字、F1–F12、编辑键、方向键，
 * 以及用物理位置命名的标点（`Minus` / `BracketLeft` …）—— 后者不写 `-` `[`，
 * 因为同一个物理键在德语键盘上是 `ß`，写符号等于把配置绑死在小众布局上。
 */
export const NAMED_KEYS = Object.freeze([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  'Space', 'Tab', 'Enter', 'Esc', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote',
]);

/** 全部合法名字（修饰键 + 普通键）。存进配置的只能是这里面的。 */
export const HOTKEY_NAMES = new Set([...MODIFIER_KEYS, ...NAMED_KEYS]);

/** 「1~3 个按键」—— 再多就不是快捷键，是一段咒语了。 */
export const MAX_HOTKEY_KEYS = 3;

/**
 * 各种叫法 → 规范名。键一律小写。
 *
 * 浏览器那边（`event.key` / `event.code`）、人类手写（`ctrl+alt+k`）、
 * 老版本留下的写法（`Cmd` / `Option`）都要能进来。
 */
const ALIASES = new Map([
  // 修饰键
  ['control', 'Ctrl'], ['ctrl', 'Ctrl'], ['ctl', 'Ctrl'],
  ['alt', 'Alt'], ['option', 'Alt'], ['opt', 'Alt'], ['altgr', 'Alt'],
  ['shift', 'Shift'],
  ['win', 'Win'], ['meta', 'Win'], ['cmd', 'Win'], ['command', 'Win'], ['super', 'Win'],
  // 编辑键
  ['esc', 'Esc'], ['escape', 'Esc'],
  ['space', 'Space'], ['spacebar', 'Space'], [' ', 'Space'],
  ['enter', 'Enter'], ['return', 'Enter'],
  ['backspace', 'Backspace'], ['delete', 'Delete'], ['del', 'Delete'], ['insert', 'Insert'],
  ['home', 'Home'], ['end', 'End'],
  ['pageup', 'PageUp'], ['pagedown', 'PageDown'],
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['arrowup', 'Up'], ['arrowdown', 'Down'], ['arrowleft', 'Left'], ['arrowright', 'Right'],
  // 标点（浏览器 `event.code` 的叫法）
  ['minus', 'Minus'], ['equal', 'Equal'],
  ['bracketleft', 'BracketLeft'], ['bracketright', 'BracketRight'],
  ['backslash', 'Backslash'], ['semicolon', 'Semicolon'], ['quote', 'Quote'],
  ['comma', 'Comma'], ['period', 'Period'], ['slash', 'Slash'], ['backquote', 'Backquote'],
]);

/** 把单个按键名洗成规范名；认不出来返回 `null`。 */
export function canonicalKey(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const lower = text.toLowerCase();
  if (ALIASES.has(lower)) return ALIASES.get(lower);
  // 字母 / 数字：不论大小写都是同一个键
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(lower)) return lower;
  if (/^f([1-9]|1[0-2])$/.test(lower)) return `F${lower.slice(1)}`;
  // 已经是规范名（`PageUp` 这种大小写敏感的）就不动它
  if (HOTKEY_NAMES.has(text)) return text;
  return null;
}

/** 规范化之后的显示文本：`Ctrl+Alt+K`。 */
export function hotkeyText(keys) {
  return Array.isArray(keys) && keys.length > 0 ? keys.join('+') : '';
}

/**
 * 把"用户按下的那几个键"洗成规范组合。
 *
 * 规则（每条都对应一个真实的踩坑）：
 *
 * - **1~3 个**。0 个 = 没设（`[]` 合法，表示"不用快捷键"）；超过 3 个拒绝。
 * - **至少一个不是修饰键**。`Ctrl+Alt+Shift` 在技术上能注册，但那是一个
 *   按了会被所有应用吞掉的组合，用户以为设好了，其实按下去什么都不该发生。
 * - **去重 + 定序**：修饰键按 `MODIFIER_KEYS` 的次序排在前面，普通键保持用户按的顺序。
 * - **不认识的名字直接拒**，而不是猜 —— 猜错的结果是"配置看着挺好，按下去没反应"。
 *
 * @param {unknown} input 数组（`['Ctrl','Alt','K']`）或字符串（`'ctrl+alt+k'` / `'K'`）
 * @returns {{ok:boolean, keys:string[], rejected:string[]}}
 */
export function normalizeHotkey(input) {
  const rejected = [];
  // 空 / 未设置 = 明确地"不配快捷键"，不算错误
  if (input === undefined || input === null || input === '') return { ok: true, keys: [], rejected };

  let list;
  if (typeof input === 'string') list = input.split('+');
  else if (Array.isArray(input)) list = input;
  else return { ok: false, keys: [], rejected: ['hotkey 必须是按键名的数组，或 "Ctrl+Alt+K" 这样的字符串'] };

  const mods = [];
  const rest = [];
  for (const item of list) {
    const name = canonicalKey(item);
    if (name === null) {
      rejected.push(`不认识的按键：「${String(item ?? '')}」（只支持字母、数字、F1–F12、方向键和常用标点，加上 Ctrl / Alt / Shift / Win）`);
      continue;
    }
    if (MODIFIER_KEYS.includes(name)) {
      if (!mods.includes(name)) mods.push(name);
    } else if (!rest.includes(name)) {
      rest.push(name);
    }
  }

  const keys = [...MODIFIER_KEYS.filter((m) => mods.includes(m)), ...rest];
  if (keys.length > MAX_HOTKEY_KEYS) {
    rejected.push(`最多 ${MAX_HOTKEY_KEYS} 个键（现在是 ${keys.length} 个）`);
  }
  if (rejected.length === 0 && keys.length > 0 && rest.length === 0) {
    rejected.push('至少要有 1 个不是修饰键的按键 —— 只有 Ctrl / Alt / Shift / Win 的组合按不出效果');
  }
  if (rejected.length > 0) return { ok: false, keys: [], rejected };
  return { ok: true, keys, rejected: [] };
}
