// dsh-harmonyos-hiboard 的浏览器半边：插件设置卡片。
//
// dsh 不会从设置 schema 自动生成表单，所以卡片必须**作为插槽内容贡献**，
// 而不是声明出来：从 dsh 0.1.6-alpha.2 起挂在 `plugins.bundle.config`
// （「插件」页里该 bundle 自己的页面上），更早的版本挂在设置页的
// `settings.plugin.item`。这里两个都挂，宿主声明哪个就填哪个。
//
// 手写在 lazy-CJS bundle 协议里（window.__ModuleLoader__.load + 返回 cordis
// 插件导出的 factory），所以**没有构建步骤**，也不 import 任何 dsh 客户端包 ——
// 与宿主半边同样的零依赖立场。
//
// 它读写宿主半边的 `/hiboard-push/config`：授权码存进插件自己的配置文件，
// 浏览器永远拿不到已保存的值（只拿打码与来源），留空保存也不会把已存的值清掉。
window.__ModuleLoader__.load({
  id: 'dsh-harmonyos-hiboard',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 「插件」页按 npm 包名分发某个 bundle 的配置，这个 key 必须与包名一致。
    var PACKAGE_NAME = 'dsh-harmonyos-hiboard';
    var ROUTE = '/hiboard-push/config';

    // 授权码的字符集与长度区间 —— 与宿主半边 src/lib/authcode.js 同一套规则。
    // 客户端 bundle 无法 import 宿主模块，所以这里是**刻意的副本**：
    // 两边规则必须一起改，改动点在此注明。
    var CODE_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
    var COMMAND_HINTS = /(openclaw|config\s+set|skills\.entries|today-task|authCode)/i;

    // 解析用户输入：整条关联指令或裸授权码都认（取指令的最后一个词）。
    function parseAuthCodeInput(raw) {
      var original = typeof raw === 'string' ? raw : '';
      if (!original.trim()) return { ok: false, reason: 'empty' };
      var firstLine =
        original
          .split(/\r?\n/)
          .map(function (line) { return line.trim(); })
          .filter(function (line) { return line.length > 0; })[0] || '';
      var text = firstLine.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '').trim();
      if (!text) return { ok: false, reason: 'empty' };
      if (!/\s/.test(text)) {
        if (CODE_PATTERN.test(text)) return { ok: true, code: text, shape: 'code' };
        return { ok: false, reason: 'invalid' };
      }
      var tokens = text.split(/\s+/).filter(Boolean);
      var last = tokens[tokens.length - 1].replace(/^[`'"]+/, '').replace(/[`'"]+$/, '');
      if (!CODE_PATTERN.test(last)) return { ok: false, reason: 'invalid' };
      return {
        ok: true,
        code: last,
        shape: 'command',
        // 不像常见指令时也照取最后一个词，但让界面说清楚这是"猜"的
        guessed: !COMMAND_HINTS.test(text)
      };
    }

    function maskAuthCode(code) {
      var s = typeof code === 'string' ? code : '';
      if (!s) return '';
      if (s.length <= 4) return new Array(s.length + 1).join('•');
      var dots = new Array(Math.min(s.length - 4, 12) + 1).join('•');
      return dots + s.slice(-4);
    }

    // ------------------------------------------------------------ 文案
    // 两组短标签而不是一套 locale bundle：卡片上就这些字，
    // 为它们装一套本地化机制比它标注的东西还重。
    var TEXT = {
      zh: {
        section: '推送设置',
        authTitle: '负一屏授权码',
        configured: '已配置',
        missing: '未配置',
        source: '当前生效来源',
        placeholder: '粘贴授权码，或整条关联指令…',
        save: '保存',
        saving: '保存中…',
        clear: '清除',
        commandHint:
          '可以直接粘贴整条关联指令，例如 openclaw config set skills.entries.today-task.config.authCode <授权码> —— 会自动从末尾取出授权码。',
        willExtract: '将从这条指令中取出授权码：',
        bareOk: '将按裸授权码保存：',
        invalid: '这串内容不像授权码（只允许字母、数字、下划线、连字符，6–128 位）。',
        emptyErr: '请先填入授权码或整条关联指令。',
        whereHint:
          '授权码获取：手机 负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体。它不会存进浏览器，字段在保存后清空。',
        guardTitle: '推送兜底（保险丝）',
        guardOn: '已开启',
        guardOff: '已关闭',
        guardHint:
          'L1 抢救"被写成纯文本的调用"、L2 抢救"承诺了推送却没调用"、L3 按错误类别重试并自动补 schedule_id。默认开启，关掉立即生效。',
        loadFailed: '读取配置失败',
        saveFailed: '保存失败',
        unavailable: '设置路由不可用（宿主未提供）。'
      },
      en: {
        section: 'Push settings',
        authTitle: 'Assistant-today authCode',
        configured: 'configured',
        missing: 'not set',
        source: 'Effective source',
        placeholder: 'Paste the authCode, or the whole linking command…',
        save: 'Save',
        saving: 'saving…',
        clear: 'Clear',
        commandHint:
          'You may paste the whole linking command, e.g. openclaw config set skills.entries.today-task.config.authCode <code> — the code is taken from the end.',
        willExtract: 'Auth code taken from that command: ',
        bareOk: 'Will be saved as a bare auth code: ',
        invalid: 'That does not look like an auth code (letters, digits, underscore, hyphen; 6–128).',
        emptyErr: 'Enter an auth code or the whole linking command first.',
        whereHint:
          'Get the code on the phone: 负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体. It is never stored in the browser; the field clears after saving.',
        guardTitle: 'Push safety net',
        guardOn: 'on',
        guardOff: 'off',
        guardHint:
          'L1 rescues a push emitted as literal text, L2 rescues a promised but never-made push, L3 retries by failure class and backfills schedule_id. On by default; switching it off takes effect immediately.',
        loadFailed: 'Could not load the configuration',
        saveFailed: 'Could not save',
        unavailable: 'The settings route is unavailable (host did not provide it).'
      }
    };

    // dsh 的语言：优先问 locale 服务（可能晚于卡片就绪，故在渲染时读），
    // 其次看页面 lang，最后看浏览器语言。
    function pickLang(localeRef) {
      try {
        var locale = localeRef && localeRef.current;
        if (locale && typeof locale.getSnapshot === 'function') {
          var active = String(locale.getSnapshot().active || '');
          if (active) return active.indexOf('zh') === 0 ? 'zh' : 'en';
        }
      } catch (error) {
        /* 语言服务异常不该影响卡片 */
      }
      try {
        var lang = String(document.documentElement.getAttribute('lang') || navigator.language || '');
        if (lang) return lang.indexOf('zh') === 0 ? 'zh' : 'en';
      } catch (error) {
        /* 忽略 */
      }
      return 'en';
    }

    // ------------------------------------------------------------ 卡片
    // 用原生元素 + dsw 的 CSS 变量，而不是 @deepseek-ai/dsh-client-ui-primitives：
    // 少一个需要跟随宿主版本变化的接口面。这些变量在 dsh web 的主题里都有定义，
    // 取不到时用中性回退值，卡片在别的宿主上也不至于看不清。
    function Card(react, localeRef) {
      var h = react.createElement;
      var useState = react.useState;
      var useEffect = react.useEffect;

      var V = {
        label: 'var(--dsw-alias-label-primary, currentColor)',
        sub: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
        border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
        bg: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
        accent: 'var(--dsw-alias-brand-primary, #4b6bfb)',
        danger: 'var(--dsw-alias-label-error, #d9534f)'
      };

      return function HiboardConfigCard() {
        var t = TEXT[pickLang(localeRef)];
        var summaryState = useState({ loading: true, data: null, error: '' });
        var summary = summaryState[0];
        var setSummary = summaryState[1];
        var draftState = useState('');
        var draft = draftState[0];
        var setDraft = draftState[1];
        var busyState = useState('');
        var busy = busyState[0];
        var setBusy = busyState[1];
        var noteState = useState('');
        var note = noteState[0];
        var setNote = noteState[1];

        var refresh = function () {
          return fetch(ROUTE, { headers: { accept: 'application/json' } })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return response.json();
            })
            .then(function (data) {
              setSummary({ loading: false, data: data, error: '' });
            })
            .catch(function (error) {
              setSummary({ loading: false, data: null, error: String((error && error.message) || error) });
            });
        };

        useEffect(function () {
          // 路由不存在（settingsCard: false，或非 web profile）时只提示，
          // 不假装卡片生效 —— 那正是"关掉一个功能"该有的样子。
          fetch(ROUTE, { method: 'GET' }).then(function (response) {
            if (response.status === 404) {
              setSummary({ loading: false, data: null, error: t.unavailable });
              return;
            }
            refresh();
          }).catch(function (error) {
            setSummary({ loading: false, data: null, error: String((error && error.message) || error) });
          });
        }, []);

        var post = function (body) {
          return fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
            .then(function (response) {
              return response.json().then(function (data) {
                if (!response.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
                return data;
              });
            })
            .then(function (data) {
              setSummary({ loading: false, data: data, error: '' });
              return data;
            })
            .catch(function (error) {
              setSummary(function (prev) {
                return { loading: false, data: prev.data, error: String((error && error.message) || error) };
              });
              return null;
            });
        };

        // 输入预览：保存前就告诉用户"会存进去什么"，避免把整段说明当授权码存了
        var parsed = draft.trim() ? parseAuthCodeInput(draft) : null;

        var onSave = function () {
          if (!draft.trim()) {
            setNote(t.emptyErr);
            return;
          }
          if (parsed && !parsed.ok) {
            setNote(t.invalid);
            return;
          }
          setBusy('auth');
          setNote('');
          post({ authCode: draft }).then(function (data) {
            setBusy('');
            if (!data) return;
            setDraft('');
            setNote((data.notes && data.notes[0]) || '');
          });
        };

        var onClear = function () {
          setBusy('auth');
          setNote('');
          post({ authCode: '' }).then(function (data) {
            setBusy('');
            if (!data) return;
            setDraft('');
            setNote((data.notes && data.notes[0]) || '');
          });
        };

        var onToggleGuard = function () {
          var next = !(summary.data && summary.data.guard && summary.data.guard.enabled);
          setBusy('guard');
          setNote('');
          post({ guardEnabled: next }).then(function () {
            setBusy('');
          });
        };

        var info = summary.data && summary.data.authCode;
        var guard = summary.data && summary.data.guard;

        var row = function (children, extra) {
          return h(
            'div',
            { style: Object.assign({ display: 'flex', alignItems: 'center', gap: '8px' }, extra || {}) },
            children
          );
        };

        var statusDot = h('span', {
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            flex: 'none',
            background: info && info.configured ? '#3ba55d' : V.danger
          }
        });

        var input = h('input', {
          type: 'text',
          value: draft,
          placeholder: t.placeholder,
          spellCheck: false,
          autoComplete: 'off',
          disabled: busy === 'auth',
          onChange: function (event) { setDraft(event.target.value); },
          onKeyDown: function (event) { if (event.key === 'Enter') onSave(); },
          style: {
            flex: '1 1 auto',
            minWidth: '0',
            padding: '6px 8px',
            fontSize: '13px',
            fontFamily: 'inherit',
            color: V.label,
            background: V.bg,
            border: '1px solid ' + V.border,
            borderRadius: '6px',
            outline: 'none'
          }
        });

        var btn = function (label, onClick, opts) {
          var o = opts || {};
          return h(
            'button',
            {
              type: 'button',
              onClick: onClick,
              disabled: Boolean(busy) || Boolean(o.disabled),
              style: {
                flex: 'none',
                padding: '6px 12px',
                fontSize: '13px',
                fontFamily: 'inherit',
                cursor: busy ? 'default' : 'pointer',
                borderRadius: '6px',
                border: o.primary ? '1px solid transparent' : '1px solid ' + V.border,
                background: o.primary ? V.accent : 'transparent',
                color: o.primary ? '#fff' : V.label,
                opacity: busy || o.disabled ? 0.6 : 1
              }
            },
            label
          );
        };

        var preview = null;
        if (parsed && parsed.ok) {
          preview = h(
            'div',
            { style: { marginTop: '6px', fontSize: '12px', color: V.sub } },
            (parsed.shape === 'command' ? t.willExtract : t.bareOk) + maskAuthCode(parsed.code)
          );
        } else if (parsed && !parsed.ok) {
          preview = h('div', { style: { marginTop: '6px', fontSize: '12px', color: V.danger } }, t.invalid);
        }

        // 兜底开关：原生 checkbox 画成开关样式，少依赖一个宿主原语
        var guardSwitch = h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': Boolean(guard && guard.enabled),
            disabled: busy === 'guard' || !guard,
            onClick: onToggleGuard,
            style: {
              flex: 'none',
              width: '42px',
              height: '22px',
              padding: '2px',
              cursor: busy === 'guard' || !guard ? 'default' : 'pointer',
              borderRadius: '11px',
              border: '1px solid ' + V.border,
              background: guard && guard.enabled ? V.accent : 'transparent',
              display: 'flex',
              justifyContent: guard && guard.enabled ? 'flex-end' : 'flex-start',
              transition: 'background .14s'
            }
          },
          h('span', {
            style: {
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 2px rgba(0,0,0,.3)'
            }
          })
        );

        return h(
          'div',
          {
            style: {
              margin: '8px 16px 16px',
              padding: '12px',
              border: '1px solid ' + V.border,
              borderRadius: '12px',
              color: V.label,
              fontSize: '13px',
              lineHeight: '1.6'
            }
          },
          h('div', { style: { fontWeight: 600, marginBottom: '10px' } }, t.section),

          // ---- 授权码 ----
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t.authTitle),
          row([
            statusDot,
            h(
              'span',
              { style: { color: V.sub } },
              (info && info.configured ? t.configured : t.missing) +
                (info && info.configured && info.masked ? ' · ' + info.masked : '')
            ),
            info && info.sourceLabel
              ? h('span', { style: { color: V.sub } }, '· ' + t.source + ': ' + info.sourceLabel)
              : null
          ], { marginBottom: '8px' }),

          row([input, btn(t.save, onSave, { primary: true }), btn(t.clear, onClear, { disabled: !(info && info.configured) })]),
          preview,
          h('div', { style: { marginTop: '8px', fontSize: '12px', color: V.sub } }, t.commandHint),
          h('div', { style: { marginTop: '4px', fontSize: '12px', color: V.sub } }, t.whereHint),

          note ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: V.accent } }, note) : null,
          summary.error
            ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: V.danger } },
                (summary.data ? t.saveFailed : t.loadFailed) + ': ' + summary.error)
            : null,

          // ---- 兜底开关 ----
          h('div', {
            style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid ' + V.border }
          },
            row([
              h('span', { style: { fontWeight: 600 } }, t.guardTitle),
              h('span', { style: { color: V.sub } }, guard && guard.enabled ? t.guardOn : t.guardOff),
              guardSwitch
            ]),
            h('div', { style: { marginTop: '6px', fontSize: '12px', color: V.sub } }, t.guardHint),
            guard
              ? h('div', { style: { marginTop: '4px', fontSize: '12px', color: V.sub } },
                  (pickLang(localeRef) === 'zh'
                    ? '重试预算：确定未送达 ' + guard.retryCount + ' 次 / 可能已送达 ' + guard.ambiguousRetryCount + ' 次；schedule_id 兜底：' + guard.defaultScheduleId
                    : 'Retry budget: definitely-undelivered ' + guard.retryCount + ' / possibly-delivered ' + guard.ambiguousRetryCount + '; schedule_id fallback: ' + guard.defaultScheduleId))
              : null
          )
        );
      };
    }

    // ------------------------------------------------------------ 注册
    function registerCard(ctx) {
      // cordis 里访问未声明的服务会抛错，所以每个可选依赖各走一次 scoped inject：
      // 服务存在时闭包才运行，不存在就整段跳过，插件照常加载。
      if (typeof ctx.inject !== 'function') return;

      var localeRef = { current: null };
      ctx.inject(['locale'], function (scope) {
        localeRef.current = scope.locale;
        if (typeof scope.effect === 'function') {
          scope.effect(function () {
            return function () { localeRef.current = null; };
          }, 'hiboard-push: locale handle');
        }
      });

      ctx.inject(['slots'], function (scope) {
        try {
          mountCard(scope, localeRef);
        } catch (error) {
          console.error('[hiboard-push] settings card skipped: ' + error);
        }
      });
    }

    function mountCard(ctx, localeRef) {
      var react;
      try {
        react = require('react');
      } catch (error) {
        console.error('[hiboard-push] settings card skipped: ' + error);
        return;
      }
      var ConfigCard = Card(react, localeRef);
      // slots.inject 会等到插槽被声明为止，所以每个宿主只填它有的那个，
      // 另一个的等待永远不会触发。
      ctx.slots.inject('plugins.bundle.config', function* () {
        yield ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, ConfigCard);
      });
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register(
          { name: 'settings.plugin.item', id: 'hiboard-push', key: 'hiboard-push', order: 32 },
          ConfigCard
        );
      });
    }

    function apply(ctx) {
      registerCard(ctx);
    }

    exports.apply = apply;
    // 仅供仓库测试使用，不属于插件契约。
    exports.__card = { parseAuthCodeInput: parseAuthCodeInput, maskAuthCode: maskAuthCode, TEXT: TEXT };
    // slots 与 locale 都是可选的，各自走 scoped inject，所以这里不声明依赖。
    exports.inject = [];
    return module.exports;
  }
});
