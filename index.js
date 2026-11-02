/**
 * Host half of the Balance plugin.
 *
 * One read-only HTTP endpoint serves the browser half with a small, stable summary of the
 * current DeepSeek account balance. The summary prefers the DSH account service (free quota /
 * platform sign-in, no API key) and falls back to the official `DEEPSEEK_API_KEY` endpoint.
 * Secrets never leave this process: the client only receives formatted amounts.
 */
import { readFileSync } from 'node:fs';

export const name = 'dsh-balance';

/** Only the web server is required; account and credential services are looked up lazily. */
export const inject = ['webServer'];

const ROUTE = '/dsh-balance';
const SUCCESS_CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const SYMBOLS = { CNY: '¥', USD: '$' };

const VERSION = (() => {
  try {
    const raw = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof raw.version === 'string' && raw.version.length > 0 ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

class BalanceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function symbolOf(currency) {
  return SYMBOLS[currency] ?? currency + ' ';
}

function toCents(value, field) {
  const n = typeof value === 'number' ? value : Number(String(value ?? ''));
  if (!Number.isFinite(n)) throw new BalanceError('bad-response', '余额字段非法：' + field);
  return Math.round(n * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

function currencyOf(wallet) {
  const raw = wallet !== null && typeof wallet === 'object' && typeof wallet.currency === 'string' ? wallet.currency : '';
  return raw.length > 0 ? raw.toUpperCase() : 'CNY';
}

function rank(currency) {
  if (currency === 'CNY') return 0;
  if (currency === 'USD') return 1;
  return 2;
}

/** Build the client summary from per-currency totals. */
function summarize(wallets, source, provider) {
  if (wallets.length === 0) throw new BalanceError('bad-response', '余额数据里没有钱包');
  const ordered = wallets.slice().sort((a, b) => rank(a.currency) - rank(b.currency));
  const primary = ordered.find((wallet) => Number(wallet.total) > 0) ?? ordered[0];
  return {
    ok: true,
    source,
    provider,
    currency: primary.currency,
    symbol: primary.symbol,
    total: primary.total,
    granted: primary.granted,
    toppedUp: primary.toppedUp,
    wallets: ordered,
    updatedAt: new Date().toISOString(),
  };
}

/** `ctx.deepseekAccount.getBalance()` → summary. Null means signed out. */
function fromAccountSnapshot(snapshot, provider) {
  if (!snapshot) throw new BalanceError('no-account', '未登录 DeepSeek 账号');
  if (snapshot.status !== 'ready') throw new BalanceError('account-failed', '账号余额查询失败');
  const normal = Array.isArray(snapshot.value) ? snapshot.value : [];
  const bonus = Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : [];
  if (normal.length === 0 && bonus.length === 0) {
    throw new BalanceError('account-failed', '账号没有可显示的钱包');
  }

  const byCurrency = new Map();
  const entry = (currency) => {
    let found = byCurrency.get(currency);
    if (found === undefined) {
      found = { currency, granted: 0, toppedUp: 0 };
      byCurrency.set(currency, found);
    }
    return found;
  };
  for (const wallet of normal) {
    entry(currencyOf(wallet)).toppedUp += toCents(wallet?.balance, 'balance');
  }
  for (const wallet of bonus) {
    entry(currencyOf(wallet)).granted += toCents(wallet?.balance, 'bonus balance');
  }

  const wallets = [...byCurrency.values()].map((wallet) => ({
    currency: wallet.currency,
    symbol: symbolOf(wallet.currency),
    total: fromCents(wallet.granted + wallet.toppedUp),
    granted: fromCents(wallet.granted),
    toppedUp: fromCents(wallet.toppedUp),
  }));
  return summarize(wallets, 'deepseek-account', provider);
}

/** Official `GET https://api.deepseek.com/user/balance` → summary. */
async function fromOfficialBalance(key, provider) {
  let response;
  try {
    response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: 'Bearer ' + key, 'user-agent': 'dsh-balance/' + VERSION },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BalanceError('fetch-error', error instanceof Error ? error.message : String(error));
  }
  if (response.status === 401 || response.status === 403) {
    throw new BalanceError('unauthorized', 'DeepSeek API Key 无效或已过期');
  }
  if (!response.ok) throw new BalanceError('fetch-error', 'DeepSeek 余额接口返回 HTTP ' + response.status);

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new BalanceError('bad-response', '余额接口返回了无效 JSON');
  }
  const infos = body?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    throw new BalanceError('bad-response', '余额接口缺少 balance_infos');
  }
  const wallets = infos.map((info) => {
    const currency = currencyOf(info);
    return {
      currency,
      symbol: symbolOf(currency),
      total: fromCents(toCents(info?.total_balance, 'total_balance')),
      granted: fromCents(toCents(info?.granted_balance, 'granted_balance')),
      toppedUp: fromCents(toCents(info?.topped_up_balance, 'topped_up_balance')),
    };
  });
  return summarize(wallets, 'deepseek-api-key', provider);
}

function providerOf(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel', false)?.currentSelection?.();
    return typeof selection?.provider === 'string' ? selection.provider : '';
  } catch {
    return '';
  }
}

async function resolveApiKey(ctx) {
  try {
    const credentials = ctx.get('credentials', false);
    if (!credentials || typeof credentials.resolve !== 'function') return '';
    const resolved = await credentials.resolve('DEEPSEEK_API_KEY');
    return typeof resolved?.value === 'string' ? resolved.value : '';
  } catch {
    return '';
  }
}

async function queryBalance(ctx) {
  const provider = providerOf(ctx);
  let accountError;
  let account;

  try {
    account = ctx.get('deepseekAccount', false);
  } catch {
    account = undefined;
  }
  if (account && typeof account.getBalance === 'function') {
    try {
      const snapshot = await account.getBalance({
        version: VERSION,
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
      return fromAccountSnapshot(snapshot, provider);
    } catch (error) {
      accountError = error;
    }
  } else {
    accountError = new BalanceError('no-account', '当前 DSH 没有账号服务');
  }

  const key = await resolveApiKey(ctx);
  if (key !== '') {
    return await fromOfficialBalance(key, provider);
  }

  if (accountError instanceof BalanceError) throw accountError;
  throw new BalanceError(
    'account-failed',
    accountError instanceof Error ? accountError.message : '未登录 DeepSeek 账号，也未配置 DEEPSEEK_API_KEY',
  );
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res, status) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'cache-control': 'no-store' });
  res.end();
}

export function apply(ctx) {
  let cached;
  let cachedAt = 0;
  let inFlight;

  const summary = async (force) => {
    if (!force && cached !== undefined && Date.now() - cachedAt < SUCCESS_CACHE_MS) return cached;
    if (inFlight !== undefined) return await inFlight;
    inFlight = (async () => {
      try {
        const next = await queryBalance(ctx);
        cached = next;
        cachedAt = Date.now();
        return next;
      } catch (error) {
        const reason = error instanceof BalanceError ? error.code : 'fetch-error';
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof BalanceError)) {
          ctx.logger?.warn?.(`[dsh-balance] 余额查询失败：${message}`);
        }
        return { ok: false, reason, message, updatedAt: new Date().toISOString() };
      } finally {
        inFlight = undefined;
      }
    })();
    return await inFlight;
  };

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let path = url.pathname;
      if (!path.startsWith(ROUTE) || (path.length > ROUTE.length && path[ROUTE.length] !== '/')) {
        return sendJson(res, 404, { ok: false, reason: 'not-found' });
      }
      path = path.slice(ROUTE.length).replace(/\/+$/, '');
      if (path === '') path = '/';

      const method = req.method ?? 'GET';
      const isSummary = path === '/' || path === '/summary';
      const isRefresh = path === '/refresh';

      if (method === 'HEAD' && (isSummary || isRefresh)) return sendEmpty(res, 200);
      if (method === 'GET' && isSummary) return sendJson(res, 200, await summary(false));
      if ((method === 'POST' || method === 'GET') && isRefresh) {
        return sendJson(res, 200, await summary(true));
      }
      return sendJson(res, method === 'GET' || method === 'HEAD' ? 404 : 405, {
        ok: false,
        reason: method === 'GET' || method === 'HEAD' ? 'not-found' : 'method-not-allowed',
      });
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-balance] 路由异常：${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 500, {
        ok: false,
        reason: 'fetch-error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }),
    'dsh-balance: summary route',
  );
}
