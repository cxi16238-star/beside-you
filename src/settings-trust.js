/**
 * 设置页接口的信任栅栏。
 *
 * ## 为什么不能省
 *
 * 本插件注册的前缀是 `/api/see-now`，比内核自己的 `/api` 长，而 webServer 的分发
 * 规则是「最长前缀优先」。也就是说**这些请求根本不会经过内核的准入检查** ——
 * 不设防的话，任何能连到 loopback 的进程都能改用户的 `see-now.json`。
 *
 * ## 两层，按序尝试
 *
 * 1. 组合里有 `connection` 服务时，问它要判定结果 —— 那就是内核给自身 `/api` 用的
 *    同一套（信任栅栏 + 浏览器认证 cookie），插件不会比应用更松。
 * 2. 没有这个服务时，用一份结构等价的复刻：Host 必须是 loopback（防 DNS rebinding）、
 *    不许跨站 fetch、客户端带了 Origin / Referer 就必须与 Host 同源。
 *
 * 判定失败一律拒（403 / 503），绝不因为「服务自己报错」就放行 —— 那是把认证关掉。
 *
 * @module src/settings-trust.js
 */

/** 同机调用方可能合法使用的地址。IPv6 的 `URL.hostname` 带方括号。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** 把 Host / Origin / Referer 拆成 `{scheme, hostname, port}`，端口按协议补默认值。 */
function authority(value, fallbackScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : `${fallbackScheme ?? 'http'}://${value.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

/** 桌面版把页面从 `dsh-app://app` 转发到 loopback 时会留下这个 Referer。 */
function isDesktopRelay(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'dsh-app:' &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * 复刻内核的 `isTrustedApiRequest`。
 *
 * 返回拒绝原因，或 `undefined` 表示放行。原因串只用固定文案，不回显调用方输入 ——
 * 免得把一个可控字符串原样送回去。
 */
function structuralReason(req) {
  const headers = req?.headers ?? {};
  const host = authority(headers.host, 'http');
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback';
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 'cross-site';

  for (const header of ['origin', 'referer']) {
    const raw = headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (header === 'referer' && isDesktopRelay(raw)) {
      // 桌面转发会剥掉两枚浏览器标记但留下这个 Referer；它不是 Origin 授权，
      // 也不覆盖已挂载的 Host 认证判定。
      if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers';
      continue;
    }
    const origin = authority(raw.trim());
    if (origin === null) return `${header}-invalid`;
    if (origin.scheme !== host.scheme || origin.hostname !== host.hostname || origin.port !== host.port) {
      return `${header}-mismatch`;
    }
  }
  return undefined;
}

/**
 * 判定一个请求该不该放行。
 *
 * @param req - `node:http` 的 IncomingMessage。
 * @param connection - 组合里的 `connection` 服务；没有则走复刻栅栏。
 * @returns `undefined` 表示放行，否则是要回的 HTTP 状态码。
 */
export function rejectionFor(req, connection) {
  // 服务存在时的两种拼法：新版是 `admit` 返回 `{rejection}`，0.1.7 之前是
  // `requestRejection` 直接返回状态码。读错一次就会把每个请求都判成 503。
  const admit = connection?.admit;
  if (typeof admit === 'function') {
    try {
      const admission = admit.call(connection, req);
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined;
      if (status === undefined) return structuralReason(req) === undefined ? undefined : 403;
      return status;
    } catch {
      return 503;
    }
  }

  const reject = connection?.requestRejection;
  if (typeof reject === 'function') {
    try {
      const status = reject.call(connection, req);
      if (status === undefined) return structuralReason(req) === undefined ? undefined : 403;
      return status;
    } catch {
      return 503;
    }
  }

  return structuralReason(req) === undefined ? undefined : 403;
}
