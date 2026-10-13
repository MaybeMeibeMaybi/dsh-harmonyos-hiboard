// dsh-harmonyos-hiboard 的浏览器半边：插件设置卡片。
//
// dsh 不会从设置 schema 自动生成表单，所以卡片必须**作为插槽内容贡献**：
// 从 dsh 0.1.6-alpha.2 起挂在 `plugins.bundle.config`（主界面侧栏「插件」面板里
// 该 bundle 自己的页面上），更早的版本挂在设置页的 `settings.plugin.item`。
// 两个都挂，宿主声明哪个就填哪个。
//
// 手写在 lazy-CJS bundle 协议里（window.__ModuleLoader__.load + 返回 cordis 插件
// 导出的 factory），所以**没有构建步骤**。
//
// 控件一律用官方原语（Button / Switch / Input）：它们的配色由
// `--dsw-alias-button-*` 等主题令牌驱动，深浅色主题都自动正确。
// 第一版这些控件是手搓样式（自己拼 background / color），这正是它们在深色模式下
// 不可读的原因 —— 所以这里不再自己决定控件配色。
//
// 它读写宿主半边的 `/hiboard-push/config`：授权码存进插件自己的配置文件，
// 浏览器永远拿不到已保存的明文（只拿打码值与来源）。
window.__ModuleLoader__.load({
  id: 'dsh-harmonyos-hiboard',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // 「插件」面板按 npm 包名分发某个 bundle 的配置，这个 key 必须与包名一致。
    var PACKAGE_NAME = 'dsh-harmonyos-hiboard';
    var ROUTE = '/hiboard-push/config';

    // 授权码的字符集与长度区间 —— 与宿主半边 src/lib/authcode.js 同一套规则。
    // 客户端 bundle 无法 import 宿主模块，所以这里是**刻意的副本**：
    // 两边规则必须一起改，仓库里有对齐测试盯着（test/authcode.test.mjs）。
    var CODE_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
    var COMMAND_HINTS = /(openclaw|config\s+set|skills\.entries|today-task|authCode)/i;

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
      return { ok: true, code: last, shape: 'command', guessed: !COMMAND_HINTS.test(text) };
    }

    function maskAuthCode(code) {
      var s = typeof code === 'string' ? code : '';
      if (!s) return '';
      if (s.length <= 4) return new Array(s.length + 1).join('•');
      return new Array(Math.min(s.length - 4, 12) + 1).join('•') + s.slice(-4);
    }

    // 审计时间是 ISO 串；面板只想要「最近几次」，显示到分钟就够。
    function shortTime(iso) {
      var s = String(iso || '');
      if (s.length < 16) return s;
      return s.slice(5, 10).replace('-', '/') + ' ' + s.slice(11, 16);
    }

    // ------------------------------------------------------------ 文案
    // 两组短标签而不是一套 locale bundle：卡片上就这些字，为它们装一套
    // 本地化机制比它标注的东西还重。
    var TEXT = {
      zh: {
        section: '推送设置',
        authTitle: '负一屏授权码',
        configured: '已配置',
        missing: '未配置',
        source: '当前生效来源',
        placeholder: '粘贴授权码，或整条关联指令…',
        save: '保存',
        clear: '清除',
        commandHint:
          '也可以直接粘贴整条关联指令，例如 openclaw config set skills.entries.today-task.config.authCode <授权码>，会自动从末尾取出授权码。',
        willExtract: '将从这条指令中取出授权码：',
        bareOk: '将按裸授权码保存：',
        invalid: '这串内容不像授权码（只允许字母、数字、下划线、连字符，6–128 位）。',
        emptyErr: '请先填入授权码或整条关联指令。',
        whereHint:
          '授权码获取：手机 负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体。不存进浏览器，字段保存后清空。',
        guardTitle: '推送兜底',
        guardOn: '已开启',
        guardOff: '已关闭',
        guardHint: '默认开启，建议保持开启。模型漏调用或调用失败时，它替你补上，卡片就不会悄悄丢掉。',
        guardWhat:
          '① 模型把调用写成了纯文本 → 替你补推　② 模型只说“推给你”却没真调用 → 替你补推　③ 调用失败 → 按错误类型重试',
        guardBudget: function (g) {
          return '重试预算：确定未送达 ' + g.retryCount + ' 次 / 可能已送达 ' + g.ambiguousRetryCount + ' 次　·　schedule_id 兜底：' + g.defaultScheduleId;
        },
        ruleTitle: '常驻推送规则',
        ruleOn: '已启用',
        ruleOff: '未启用',
        ruleHint: '保存授权码时，会自动把「每轮都要推送」写进全局指令文件 AGENTS.md（带标记、可随时移除），新会话即生效。',
        ruleCustom: '检测到你已手写过推送规则 —— 插件不会改动你的 AGENTS.md。',
        ruleBlockPresent: 'AGENTS.md 里已有本插件维护的规则段（带标记；关掉即可移除）。',
        debugTitle: '兜底战绩',
        debugSummary: function (c) {
          return '已救回 ' + (c.retryOk + c.rescueOk) + ' 次（重试 ' + c.retryOk + ' · 补推 ' + c.rescueOk + '）';
        },
        debugEmpty: '还没有需要兜底的记录 —— 每次推送都成功调用了工具。',
        debugNone: '兜底还没有运行记录。',
        debugMissedSummary: function (c) {
          return '兜底已关闭 —— 期间漏掉未推送 ' + c.missed + ' 次';
        },
        debugMissedEmpty: '兜底关闭期间还没有漏推记录。',
        kindRetry: '重试',
        kindRescue: '补推',
        kindMissed: '漏推',
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
        clear: 'Clear',
        commandHint:
          'You may also paste the whole linking command, e.g. openclaw config set skills.entries.today-task.config.authCode <code>; the code is taken from the end.',
        willExtract: 'Auth code taken from that command: ',
        bareOk: 'Will be saved as a bare auth code: ',
        invalid: 'That does not look like an auth code (letters, digits, underscore, hyphen; 6–128).',
        emptyErr: 'Enter an auth code or the whole linking command first.',
        whereHint:
          'Get the code on the phone: 负一屏 → 我的 → 动态管理 → 关联账号 → Claw 智能体. Never stored in the browser; the field clears after saving.',
        guardTitle: 'Push safety net',
        guardOn: 'on',
        guardOff: 'off',
        guardHint: 'On by default and best left on. When the model misses the call or a call fails, it steps in so a card is not silently lost.',
        guardWhat:
          '1) the model wrote the call as plain text → it pushes for you　2) the model promised a push but never called → it pushes for you　3) a call failed → it retries by error type',
        guardBudget: function (g) {
          return 'Retry budget: definitely-undelivered ' + g.retryCount + ' / possibly-delivered ' + g.ambiguousRetryCount + '　·　schedule_id fallback: ' + g.defaultScheduleId;
        },
        ruleTitle: 'Always-push rule',
        ruleOn: 'enabled',
        ruleOff: 'disabled',
        ruleHint: 'Saving the authCode also writes an "every turn must push" rule into your global instruction file AGENTS.md (marker-delimited, removable); new sessions pick it up.',
        ruleCustom: 'You already wrote a push rule by hand, so this plugin leaves AGENTS.md untouched.',
        ruleBlockPresent: "AGENTS.md already carries this plugin's rule block (marker-delimited; switch this off to remove it).",
        debugTitle: 'Rescues so far',
        debugSummary: function (c) {
          return 'Saved ' + (c.retryOk + c.rescueOk) + ' (retries ' + c.retryOk + ', pushes ' + c.rescueOk + ')';
        },
        debugEmpty: 'Nothing needed rescuing yet — every push called the tool successfully.',
        debugNone: 'The safety net has no run records yet.',
        debugMissedSummary: function (c) {
          return 'Safety net is off — ' + c.missed + ' pushes have gone missing since';
        },
        debugMissedEmpty: 'Nothing has gone missing while the net was off.',
        kindRetry: 'retry',
        kindRescue: 'rescue',
        kindMissed: 'missed',
        loadFailed: 'Could not load the configuration',
        saveFailed: 'Could not save',
        unavailable: 'The settings route is unavailable (host did not provide it).'
      }
    };

    /** dsh 的语言：优先问 locale 服务（可能晚于卡片就绪，故在渲染时读），其次页面 lang。 */
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
    function Card(react, ui, localeRef) {
      var h = react.createElement;
      var useState = react.useState;
      var useEffect = react.useEffect;
      var Button = ui.Button;
      var Switch = ui.Switch;
      var Input = ui.Input;

      // 只留排版用的中性令牌：**控件配色全部交给官方原语**，免得深浅色各错一次。
      var V = {
        sub: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
        border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
        danger: 'var(--dsw-alias-label-error, #d9534f)',
        ok: 'var(--dsw-alias-label-success, #3ba55d)'
      };

      return function HiboardConfigCard() {
        var t = TEXT[pickLang(localeRef)];
        var state = useState({ loading: true, data: null, error: '' });
        var summary = state[0];
        var setSummary = state[1];
        var draftState = useState('');
        var draft = draftState[0];
        var setDraft = draftState[1];
        var busyState = useState('');
        var busy = busyState[0];
        var setBusy = busyState[1];
        var noteState = useState('');
        var note = noteState[0];
        var setNote = noteState[1];
        var showDebugState = useState(true);
        var showDebug = showDebugState[0];
        var setShowDebug = showDebugState[1];

        var refresh = function () {
          return fetch(ROUTE, { headers: { accept: 'application/json' } })
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              return response.json();
            })
            .then(function (data) { setSummary({ loading: false, data: data, error: '' }); })
            .catch(function (error) {
              setSummary({ loading: false, data: null, error: String((error && error.message) || error) });
            });
        };

        useEffect(function () {
          // 路由不存在（settingsCard: false，或非 web profile）时只提示，不假装卡片生效
          fetch(ROUTE, { method: 'GET' })
            .then(function (response) {
              if (response.status === 404) {
                setSummary({ loading: false, data: null, error: t.unavailable });
                return;
              }
              refresh();
            })
            .catch(function (error) {
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
            .then(function (data) { setSummary({ loading: false, data: data, error: '' }); return data; })
            .catch(function (error) {
              setSummary(function (prev) {
                return { loading: false, data: prev.data, error: String((error && error.message) || error) };
              });
              return null;
            });
        };

        var parsed = draft.trim() ? parseAuthCodeInput(draft) : null;
        var info = summary.data && summary.data.authCode;
        var guard = summary.data && summary.data.guard;
        var audit = summary.data && summary.data.audit;
        var rule = summary.data && summary.data.rule;

        var onSave = function () {
          if (!draft.trim()) { setNote(t.emptyErr); return; }
          if (parsed && !parsed.ok) { setNote(t.invalid); return; }
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
        var onToggleRule = function (next) {
          setBusy('rule');
          setNote('');
          post({ ruleEnabled: next }).then(function (data) {
            setBusy('');
            if (data && data.notes && data.notes[0]) setNote(data.notes[0]);
          });
        };
        var onToggleGuard = function (next) {
          setBusy('guard');
          setNote('');
          post({ guardEnabled: next }).then(function () { setBusy(''); });
        };

        var row = function (children, extra) {
          return h(
            'div',
            { style: Object.assign({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }, extra || {}) },
            children
          );
        };
        var muted = function (text, extra) {
          return h('div', { style: Object.assign({ fontSize: '12px', lineHeight: '1.7', color: V.sub }, extra || {}) }, text);
        };
        var heading = function (text) {
          return h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, text);
        };

        var statusDot = h('span', {
          style: {
            width: '8px', height: '8px', borderRadius: '50%', flex: 'none',
            background: info && info.configured ? V.ok : V.danger
          }
        });

        var input = h(Input, {
          type: 'text',
          value: draft,
          placeholder: t.placeholder,
          spellCheck: false,
          autoComplete: 'off',
          disabled: busy === 'auth',
          onChange: function (event) { setDraft(event.target.value); },
          onKeyDown: function (event) { if (event.key === 'Enter') onSave(); },
          style: { flex: '1 1 220px', minWidth: '0' }
        });

        var preview = null;
        if (parsed && parsed.ok) {
          preview = muted((parsed.shape === 'command' ? t.willExtract : t.bareOk) + maskAuthCode(parsed.code), { marginTop: '6px' });
        } else if (parsed && !parsed.ok) {
          preview = h('div', { style: { marginTop: '6px', fontSize: '12px', color: V.danger } }, t.invalid);
        }

        // ---- 战绩面板 ----
        // 兜底**开着**：显示「救回了几次」。
        // 兜底**关掉**：面板不消失，改显示「漏掉了几张」—— 关掉它的代价要看得见，
        // 否则用户只会觉得"关了就关了"，直到发现卡片少了几张。
        var guardOn = Boolean(guard && guard.enabled);
        var itemRows = function (items, kindOf) {
          return (items || []).map(function (item, index) {
            return h(
              'div',
              { key: String(index), style: { fontSize: '12px', lineHeight: '1.7', color: V.sub } },
              '· ' + shortTime(item.at) + '　[' + kindOf(item) + '] ' + (item.label || '-') + ' — ' + item.detail
            );
          });
        };
        var boldLine = function (text) {
          return h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, text);
        };
        var debugBody;
        if (!audit) {
          debugBody = muted(t.debugNone);
        } else if (guardOn) {
          debugBody =
            !audit.exists || audit.counts.retryOk + audit.counts.rescueOk === 0
              ? muted(t.debugEmpty)
              : h(
                  'div',
                  null,
                  boldLine(t.debugSummary(audit.counts)),
                  itemRows(audit.recent, function (item) {
                    return item.kind === 'retry-ok' ? t.kindRetry : t.kindRescue;
                  })
                );
        } else {
          debugBody =
            !audit.exists || audit.counts.missed === 0
              ? muted(t.debugMissedEmpty)
              : h(
                  'div',
                  null,
                  boldLine(t.debugMissedSummary(audit.counts)),
                  itemRows(audit.missedRecent, function () { return t.kindMissed; })
                );
        }

        return h(
          'div',
          {
            style: {
              margin: '8px 16px 16px',
              padding: '12px',
              border: '1px solid ' + V.border,
              borderRadius: '12px',
              fontSize: '13px',
              lineHeight: '1.6'
            }
          },
          h('div', { style: { fontWeight: 600, marginBottom: '10px' } }, t.section),

          // ---- 授权码 ----
          heading(t.authTitle),
          row(
            [
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
            ],
            { marginBottom: '8px' }
          ),
          row([
            input,
            h(Button, { variant: 'primary', size: 'sm', onClick: onSave, disabled: busy === 'auth' }, t.save),
            h(Button, { variant: 'outline', size: 'sm', onClick: onClear, disabled: busy === 'auth' || !(info && info.configured) }, t.clear)
          ]),
          preview,
          muted(t.commandHint, { marginTop: '8px' }),
          muted(t.whereHint, { marginTop: '4px' }),
          note ? h('div', { style: { marginTop: '8px', fontSize: '12px' } }, note) : null,
          summary.error
            ? h(
                'div',
                { style: { marginTop: '8px', fontSize: '12px', color: V.danger } },
                (summary.data ? t.saveFailed : t.loadFailed) + ': ' + summary.error
              )
            : null,

          // ---- 推送兜底 + 调试图 ----
          h(
            'div',
            { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid ' + V.border } },
            row([
              h('span', { style: { fontWeight: 600 } }, t.guardTitle),
              h('span', { style: { color: V.sub } }, guard && guard.enabled ? t.guardOn : t.guardOff),
              h(Switch, {
                checked: Boolean(guard && guard.enabled),
                onChange: onToggleGuard,
                label: t.guardTitle,
                disabled: busy === 'guard' || !guard
              })
            ]),
            muted(t.guardHint, { marginTop: '6px' }),
            muted(t.guardWhat, { marginTop: '4px' }),
            guard ? muted(t.guardBudget(guard), { marginTop: '4px' }) : null,

            h(
              'div',
              { style: { marginTop: '10px' } },
              h(
                'div',
                {
                  role: 'button',
                  tabIndex: 0,
                  onClick: function () { setShowDebug(!showDebug); },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' || event.key === ' ') setShowDebug(!showDebug);
                  },
                  style: { fontSize: '12px', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }
                },
                (showDebug ? '▾ ' : '▸ ') + t.debugTitle
              ),
              showDebug ? h('div', { style: { marginTop: '4px' } }, debugBody) : null
            )
          ),

          // ---- 常驻推送规则：保存授权码时自动写进全局指令文件 ----
          h(
            'div',
            { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid ' + V.border } },
            row([
              h('span', { style: { fontWeight: 600 } }, t.ruleTitle),
              h('span', { style: { color: V.sub } }, rule && rule.enabled ? t.ruleOn : t.ruleOff),
              h(Switch, {
                checked: Boolean(rule && rule.enabled),
                onChange: onToggleRule,
                label: t.ruleTitle,
                disabled: busy === 'rule' || !rule
              })
            ]),
            muted(
              rule && rule.customRule ? t.ruleCustom : rule && rule.block ? t.ruleBlockPresent : t.ruleHint,
              { marginTop: '6px' }
            )
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
          scope.effect(function () { return function () { localeRef.current = null; }; }, 'hiboard-push: locale handle');
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
      var ui;
      try {
        ui = require('@deepseek-ai/dsh-client-ui-primitives');
      } catch (error) {
        // 拿不到原语就不渲染：宁可不显示，也不要退回手搓样式再错一次深浅色
        console.error('[hiboard-push] settings card skipped (primitives unavailable): ' + error);
        return;
      }
      var ConfigCard = Card(react, ui, localeRef);
      // slots.inject 会等到插槽被声明为止，所以每个宿主只填它有的那个
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
    exports.__card = { parseAuthCodeInput: parseAuthCodeInput, maskAuthCode: maskAuthCode, TEXT: TEXT, shortTime: shortTime };
    // slots 与 locale 都是可选的，各自走 scoped inject，所以这里不声明依赖。
    exports.inject = [];
    return module.exports;
  }
});
