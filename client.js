/**
 * Browser half of the Balance plugin.
 *
 * Registers a compact chip in the conversation composer dock. The chip reads the host summary
 * route, refreshes on click, and polls once a minute while the page is visible. All colors come
 * from `--dsw-alias-*` theme tokens so light and dark themes need no extra wiring.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-balance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'dsh-balance';
    const ROUTE = '/dsh-balance';
    const POLL_MS = 60_000;

    const zh = {
      label: '余额',
      loading: '查询中',
      unavailable: '余额不可用',
      granted: '赠送',
      toppedUp: '充值',
      updated: '更新于',
      clickRefresh: '点击刷新',
      clickRetry: '点击重试',
      'reason.no-account': '未登录 DeepSeek 账号，也未配置 DEEPSEEK_API_KEY',
      'reason.account-failed': '账号余额查询失败',
      'reason.unauthorized': '登录已失效或 API Key 无效',
      'reason.fetch-error': '查询余额失败',
      'reason.bad-response': '余额接口返回了无法识别的数据',
      'reason.network': '网络请求失败',
      'reason.method-not-allowed': '请求方式不受支持',
      'reason.not-found': '余额接口不存在',
    };

    const en = {
      label: 'Balance',
      loading: 'Checking',
      unavailable: 'Balance unavailable',
      granted: 'Granted',
      toppedUp: 'Topped up',
      updated: 'Updated',
      clickRefresh: 'Click to refresh',
      clickRetry: 'Click to retry',
      'reason.no-account': 'Not signed in to DeepSeek and no DEEPSEEK_API_KEY is configured',
      'reason.account-failed': 'The account balance query failed',
      'reason.unauthorized': 'Sign-in expired or the API key is invalid',
      'reason.fetch-error': 'The balance query failed',
      'reason.bad-response': 'The balance endpoint returned unrecognized data',
      'reason.network': 'The network request failed',
      'reason.method-not-allowed': 'Unsupported request method',
      'reason.not-found': 'The balance endpoint is missing',
    };

    const CSS = [
      '.dsh-balance-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;',
      'border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));border-radius:999px;',
      'background:var(--dsw-alias-bg-layer-1, transparent);color:var(--dsw-alias-label-secondary, inherit);',
      'font-family:inherit;font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer;',
      'transition:background .12s ease,border-color .12s ease,opacity .12s ease}',
      '.dsh-balance-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));',
      'border-color:var(--dsw-alias-border-l2, rgba(127,127,127,.42))}',
      '.dsh-balance-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary, #2f6fed);outline-offset:2px}',
      '.dsh-balance-chip[data-busy="true"]{opacity:.72}',
      '.dsh-balance-chip[data-state="error"]{color:var(--dsw-alias-state-warning-primary, #b45309)}',
      '.dsh-balance-chip__value{font-weight:500;font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-primary, inherit)}',
      '.dsh-balance-chip__icon{flex:none;display:block}',
      '.dsh-balance-chip__spin{animation:dsh-balance-spin 1s linear infinite}',
      '@keyframes dsh-balance-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.dsh-balance-chip__spin{animation:none}}',
    ].join('');

    function WalletIcon() {
      return h(
        'svg',
        {
          className: 'dsh-balance-chip__icon',
          viewBox: '0 0 16 16',
          width: 13,
          height: 13,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          fill: 'currentColor',
          d: 'M2 4.5C2 3.67 2.67 3 3.5 3h8A1.5 1.5 0 0 1 13 4.5V5h.5A1.5 1.5 0 0 1 15 6.5v5A1.5 1.5 0 0 1 13.5 13h-10A1.5 1.5 0 0 1 2 11.5v-7Zm1.5-.5a.5.5 0 0 0-.5.5V5h9.5v-.5a.5.5 0 0 0-.5-.5H3.5ZM13 6h-2.5A1.5 1.5 0 0 0 9 7.5v1A1.5 1.5 0 0 0 10.5 10H13V6Zm-3.5 1.5a.5.5 0 0 1 .5-.5h.5a.5.5 0 0 1 0 1H10a.5.5 0 0 1-.5-.5Z',
        }),
      );
    }

    function RefreshIcon(props) {
      return h(
        'svg',
        {
          className: 'dsh-balance-chip__icon' + (props.spinning ? ' dsh-balance-chip__spin' : ''),
          viewBox: '0 0 16 16',
          width: 11,
          height: 11,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          fill: 'currentColor',
          d: 'M8 2.5a5.5 5.5 0 1 1-5.2 7.3.6.6 0 0 1 1.13-.4A4.3 4.3 0 1 0 4.4 5.2L6 6.8H2.2V3l1.34 1.34A5.5 5.5 0 0 1 8 2.5Z',
        }),
      );
    }

    function makeChip(t) {
      const tr = (key) => {
        let value;
        try {
          value = t(key);
        } catch {
          value = undefined;
        }
        return typeof value === 'string' && value !== key ? value : (zh[key] ?? en[key] ?? key);
      };

      return function BalanceChip() {
        const [data, setData] = useState(null);
        const [error, setError] = useState(null);
        const [loading, setLoading] = useState(false);
        const current = useRef(null);

        const load = useCallback(async (force) => {
          if (current.current !== null) current.current.abort();
          const controller = new AbortController();
          current.current = controller;
          setLoading(true);
          try {
            const response = await fetch(ROUTE + (force ? '/refresh' : '/summary'), {
              method: force ? 'POST' : 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
              signal: controller.signal,
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload === null) {
              throw new Error('HTTP ' + response.status);
            }
            if (payload.ok === true) {
              setData(payload);
              setError(null);
            } else {
              setError(payload);
            }
          } catch (failure) {
            if (failure instanceof Error && failure.name === 'AbortError') return;
            setError({
              ok: false,
              reason: 'network',
              message: failure instanceof Error ? failure.message : String(failure),
            });
          } finally {
            if (current.current === controller) {
              current.current = null;
              setLoading(false);
            }
          }
        }, []);

        useEffect(() => {
          load(false);
          const timer = setInterval(() => {
            if (document.visibilityState === 'visible') load(false);
          }, POLL_MS);
          const onVisibility = () => {
            if (document.visibilityState === 'visible') load(false);
          };
          document.addEventListener('visibilitychange', onVisibility);
          return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
            if (current.current !== null) current.current.abort();
          };
        }, [load]);

        const ok = data !== null && data.ok === true;
        const state = error !== null ? 'error' : 'ok';
        const value = ok ? String(data.symbol ?? '') + String(data.total ?? '') : '—';
        const label = error !== null ? tr('unavailable') : ok ? tr('label') : tr('loading');

        let title;
        if (error !== null) {
          const reason = tr('reason.' + String(error.reason ?? 'fetch-error'));
          title = tr('unavailable') + '\n' + reason + '\n' + tr('clickRetry');
        } else if (ok) {
          const lines = [tr('label') + ' ' + value];
          const wallets = Array.isArray(data.wallets) ? data.wallets : [];
          if (wallets.length > 1) {
            lines.push(wallets.map((wallet) => String(wallet.symbol ?? '') + String(wallet.total ?? '')).join(' · '));
          } else {
            const symbol = String(data.symbol ?? '');
            lines.push(
              tr('toppedUp') +
                ' ' +
                symbol +
                String(data.toppedUp ?? '') +
                ' · ' +
                tr('granted') +
                ' ' +
                symbol +
                String(data.granted ?? ''),
            );
          }
          const when = new Date(data.updatedAt);
          if (!Number.isNaN(when.getTime())) {
            lines.push(tr('updated') + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          }
          lines.push(loading ? tr('loading') : tr('clickRefresh'));
          title = lines.filter((line) => line !== '').join('\n');
        } else {
          title = tr('loading');
        }

        return h(
          React.Fragment,
          null,
          h('style', { 'data-plugin-css': 'dsh-balance/chip.css' }, CSS),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-balance-chip',
              'data-state': state,
              'data-busy': loading ? 'true' : 'false',
              'aria-label': title,
              'aria-busy': loading ? 'true' : 'false',
              title,
              onClick: () => load(true),
            },
            h(WalletIcon, null),
            h('span', null, label),
            ok ? h('span', { className: 'dsh-balance-chip__value' }, value) : null,
            h(RefreshIcon, { spinning: loading }),
          ),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-balance: locale');
        const t = ctx.locale.bind(NS);
        const Chip = makeChip(t);

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.composer.dock', () =>
              ctx.slots.register(
                { name: 'conversation.composer.dock', id: 'dsh-balance', order: 20 },
                Chip,
              ),
            ),
          'dsh-balance: composer chip',
        );
      },
    };
  },
});
