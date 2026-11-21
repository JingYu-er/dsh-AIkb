/* dsh-AIkb — the workspace tab (conversation.view) plus the plugin page inside DSH Settings. */
window.__ModuleLoader__.load({
  id: 'dsh-aikb',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var ID = 'dsh-aikb';
    var SRC = 'http://127.0.0.1:7341/';
    var API = '/api/v1/aikb';

    function KbPage() {
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        React.createElement('div', { style: { padding: '8px 12px', borderBottom: '1px solid #2a2e36', fontSize: 12, color: '#8b96a8' } },
          'dsh-AIkb · ',
          React.createElement('a', { href: SRC, target: '_blank', rel: 'noreferrer', style: { color: '#9cc7ff' } }, '在新页打开')),
        React.createElement('iframe', {
          src: SRC,
          title: 'dsh-AIkb',
          style: { flex: 1, width: '100%', border: '0', background: '#14161a' },
        }));
    }

    // ---- settings page ---------------------------------------------------
    // Every value comes from the plugin's own host routes (same origin as this
    // page), so nothing here depends on the config file being readable in the
    // browser. Writes go through /config, which validates and returns the new
    // revision; a stale revision is reported instead of silently overwriting.

    var TOK = {
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      sub: 'var(--dsw-alias-label-secondary, #5b6472)',
      faint: 'var(--dsw-alias-label-tertiary, #8b96a8)',
      border: 'var(--dsw-alias-border-l1, #e3e6ea)',
      card: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
      err: 'var(--dsw-alias-state-error-primary, #b4453c)',
      warn: 'var(--dsw-alias-state-warning-primary, #9a6a12)',
      ok: 'var(--dsw-alias-state-success-primary, #2f7d4f)',
      accent: 'var(--dsw-alias-accent-primary, #2f6fd0)',
    };

    var ROW = { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0', fontSize: 13, color: TOK.text };
    var LABEL = { flex: '0 0 132px', color: TOK.sub, fontSize: 12 };
    var INPUT = { flex: 1, minWidth: 0, padding: '5px 7px', fontSize: 12, fontFamily: 'inherit', color: TOK.text, background: 'transparent', border: '1px solid ' + TOK.border, borderRadius: 6 };
    var BTN = { padding: '5px 10px', fontSize: 12, fontFamily: 'inherit', color: TOK.text, background: 'transparent', border: '1px solid ' + TOK.border, borderRadius: 6, cursor: 'pointer' };
    var BTN_ON = Object.assign({}, BTN, { borderColor: TOK.accent, color: TOK.accent });
    var GROUP = { margin: '18px 0 6px', fontSize: 12, color: TOK.faint };
    var CARD = { border: '1px solid ' + TOK.border, borderRadius: 8, padding: 10, margin: '6px 0', background: TOK.card };

    function slugId(name) {
      return String(name || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'vault';
    }

    function readJson(res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }

    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson);
    }

    function KbSettings() {
      var cfgState = React.useState(null);
      var cfg = cfgState[0], setCfg = cfgState[1];
      var draftState = React.useState(null);
      var draft = draftState[0], setDraft = draftState[1];
      var revState = React.useState('');
      var rev = revState[0], setRev = revState[1];
      var msgState = React.useState({ text: '读取配置…', kind: 'sub' });
      var msg = msgState[0], setMsg = msgState[1];
      var sheetState = React.useState({ text: '', loaded: false, exists: false });
      var sheet = sheetState[0], setSheet = sheetState[1];
      var fbsState = React.useState([]);
      var fbs = fbsState[0], setFbs = fbsState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var newState = React.useState({ dir: '', name: '', template: 'notes' });
      var fresh = newState[0], setFresh = newState[1];

      var say = function (text, kind) { setMsg({ text: text, kind: kind || 'sub' }); };

      var adopt = function (body) {
        setCfg(body);
        setRev(body.revision || '');
        setDraft({
          vaults: (body.vaults || []).map(function (v) { return { id: v.id, name: v.name, dir: v.dir, exists: v.exists }; }),
          activeIndex: Math.max(0, (body.vaults || []).findIndex(function (v) { return v.id === body.activeVault; })),
          packDir: body.config.packDir || '',
          toolchainDir: body.config.toolchainDir || '',
          promoteDir: body.config.promoteDir || '',
          allowWrites: !!body.config.allowWrites,
          ocrEnabled: !!body.config.ocrEnabled,
          embedEnabled: !!body.config.embedEnabled,
          embedOnIngest: !!body.config.embedOnIngest,
          rerankEnabled: !!body.config.rerankEnabled,
          ocrWorkers: Number(body.config.ocrWorkers) || 4,
        });
      };

      var loadSheet = function (address) {
        return fetch(API + '/schema?address=' + encodeURIComponent(address || ''))
          .then(readJson)
          .then(function (res) {
            if (res.status !== 200 || !res.body.ok) { setSheet({ text: '', loaded: false, exists: false }); return; }
            setSheet({ text: res.body.exists ? res.body.text : (res.body.template || ''), loaded: true, exists: !!res.body.exists, allowWrites: !!res.body.allowWrites });
          })
          .catch(function () { setSheet({ text: '', loaded: false, exists: false }); });
      };

      var loadFeedback = function () {
        return fetch(API + '/feedback')
          .then(readJson)
          .then(function (res) { if (res.status === 200 && res.body.ok) { setFbs(res.body.rows || []); } })
          .catch(function () { setFbs([]); });
      };

      React.useEffect(function () {
        var alive = true;
        fetch(API + '/config').then(readJson).then(function (res) {
          if (!alive) return;
          if (res.status === 200 && res.body.ok) {
            adopt(res.body);
            var missing = (res.body.missing || []).join(', ');
            say(missing === '' ? '配置就绪。' : '还缺：' + missing, missing === '' ? 'ok' : 'warn');
            var active = (res.body.vaults || [])[res.body.vaults.findIndex(function (v) { return v.active; })];
            return loadSheet(active ? active.dir : '');
          }
          say('读取配置失败：' + ((res.body && res.body.error && res.body.error.message) || '接口未就绪'), 'err');
        }).catch(function (error) { if (alive) say('读取配置失败：' + error, 'err'); });
        loadFeedback();
        return function () { alive = false; };
      }, []);

      var reload = function () {
        return fetch(API + '/config').then(readJson).then(function (res) {
          if (res.status === 200 && res.body.ok) { adopt(res.body); return res.body; }
          return null;
        });
      };

      var patchDraft = function (key, value) {
        setDraft(function (prev) { if (!prev) return prev; var next = Object.assign({}, prev); next[key] = value; return next; });
      };

      var patchVault = function (index, key, value) {
        setDraft(function (prev) {
          if (!prev) return prev;
          var vaults = prev.vaults.slice();
          vaults[index] = Object.assign({}, vaults[index], { [key]: value });
          return Object.assign({}, prev, { vaults: vaults });
        });
      };

      var activeDir = function () {
        if (!draft || !draft.vaults.length) return '';
        var v = draft.vaults[Math.min(draft.activeIndex, draft.vaults.length - 1)];
        return v ? v.dir : '';
      };

      var save = function () {
        if (!draft) return Promise.resolve();
        var vaults = draft.vaults
          .filter(function (v) { return v && (v.name || v.dir); })
          .map(function (v) { return { id: v.id || slugId(v.name || v.dir), name: v.name || v.dir, dir: v.dir }; });
        if (!vaults.length) { say('至少配置一个知识库。', 'err'); return Promise.resolve(); }
        var body = {
          patch: {
            vaults: vaults,
            activeVault: vaults[Math.min(draft.activeIndex, vaults.length - 1)].id,
            packDir: draft.packDir.trim(),
            toolchainDir: draft.toolchainDir.trim(),
            promoteDir: draft.promoteDir.trim(),
            allowWrites: draft.allowWrites,
            ocrEnabled: draft.ocrEnabled,
            embedEnabled: draft.embedEnabled,
            embedOnIngest: draft.embedOnIngest,
            rerankEnabled: draft.rerankEnabled,
            ocrWorkers: draft.ocrWorkers,
          },
          expectRevision: rev,
        };
        setBusy(true);
        return post('/config', body).then(function (res) {
          if (res.status === 200 && res.body.ok) {
            adopt(res.body);
            say('已保存（revision ' + (res.body.revision || '') + '）。', 'ok');
            var active = (res.body.vaults || []).filter(function (v) { return v.active; })[0];
            return loadSheet(active ? active.dir : '');
          }
          if (res.status === 409) {
            say('保存失败：配置在别处改过了，已重新读取，请再改一次。', 'warn');
            return reload();
          }
          var problems = (res.body && res.body.problems) || [];
          var detail = problems.length
            ? problems.map(function (p) { return p.field + '：' + p.message; }).join(String.fromCharCode(10))
            : ((res.body && res.body.error && res.body.error.message) || '未知原因');
          say('保存失败：' + detail, 'err');
        }).catch(function (error) { say('保存失败：' + error, 'err'); }).then(function () { setBusy(false); });
      };

      var addVault = function () {
        setDraft(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { vaults: prev.vaults.concat([{ id: '', name: '', dir: '', exists: false }]) });
        });
        say('填上名称与绝对路径后点保存。', 'sub');
      };

      var removeVault = function (index) {
        setDraft(function (prev) {
          if (!prev) return prev;
          var vaults = prev.vaults.slice();
          vaults.splice(index, 1);
          return Object.assign({}, prev, { vaults: vaults, activeIndex: Math.max(0, Math.min(prev.activeIndex, vaults.length - 1)) });
        });
      };

      var createVault = function () {
        var dir = fresh.dir.trim();
        if (dir === '') { say('新建知识库需要目录的绝对路径。', 'err'); return; }
        setBusy(true);
        post('/vault/init', { dir: dir, name: fresh.name.trim(), template: fresh.template, activate: true })
          .then(function (res) {
            if (res.status === 200 && res.body.ok) {
              var reg = res.body.registered || {};
              setFresh({ dir: '', name: '', template: 'notes' });
              say('已新建 ' + (res.body.vault && res.body.vault.dir) + '，并' + (reg.alreadyRegistered ? '复用同目录条目' : '注册为知识库 ' + (reg.name || '')) + '。', 'ok');
              return reload().then(function (body) {
                var active = body && (body.vaults || []).filter(function (v) { return v.active; })[0];
                return loadSheet(active ? active.dir : '');
              });
            }
            say('新建失败：' + ((res.body && res.body.error && res.body.error.message) || '未知原因'), 'err');
          })
          .catch(function (error) { say('新建失败：' + error, 'err'); })
          .then(function () { setBusy(false); });
      };

      var saveSheet = function () {
        setBusy(true);
        post('/schema', { text: sheet.text, address: activeDir() }).then(function (res) {
          if (res.status === 200 && res.body.ok) { say('库约定已保存（' + res.body.bytes + ' 字节）。', 'ok'); setSheet(Object.assign({}, sheet, { exists: true })); return; }
          say('库约定保存失败：' + ((res.body && res.body.error && res.body.error.message) || '未知原因'), 'err');
        }).catch(function (error) { say('库约定保存失败：' + error, 'err'); }).then(function () { setBusy(false); });
      };

      var markDone = function (index) {
        post('/feedback/done', { index: index }).then(function (res) {
          if (res.status === 200 && res.body.ok) { setFbs(res.body.rows || []); return; }
          say('标记失败：' + ((res.body && res.body.error && res.body.error.message) || '未知原因'), 'err');
        }).catch(function (error) { say('标记失败：' + error, 'err'); });
      };

      if (!draft) {
        return React.createElement('div', { style: { padding: 16, fontSize: 13, color: msg.kind === 'err' ? TOK.err : TOK.sub } }, msg.text);
      }

      var vaultRows = draft.vaults.map(function (v, i) {
        return React.createElement('div', { key: i, style: Object.assign({}, CARD, { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }) },
          React.createElement('input', {
            type: 'radio', name: 'kb-active', checked: i === draft.activeIndex,
            onChange: function () { patchDraft('activeIndex', i); },
            title: '设为当前库',
          }),
          React.createElement('input', {
            style: Object.assign({}, INPUT, { flex: '0 0 170px' }), value: v.name, placeholder: '名称',
            onChange: function (e) { patchVault(i, 'name', e.target.value); },
          }),
          React.createElement('input', {
            style: INPUT, value: v.dir, placeholder: '绝对路径，例如 D:/notes',
            onChange: function (e) { patchVault(i, 'dir', e.target.value); },
          }),
          v.exists === false ? React.createElement('span', { style: { color: TOK.err, fontSize: 11, flex: 'none' } }, '目录不存在') : null,
          React.createElement('button', { style: BTN, onClick: function () { removeVault(i); }, type: 'button' }, '移除'));
      });

      var toggle = function (key, label) {
        return React.createElement('label', { style: ROW, key: key },
          React.createElement('span', { style: LABEL }, label),
          React.createElement('input', {
            type: 'checkbox', checked: !!draft[key],
            onChange: function (e) { patchDraft(key, e.target.checked); },
          }));
      };

      return React.createElement('div', { style: { padding: '14px 16px 24px', fontSize: 13, color: TOK.text, maxWidth: 760 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
          React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, '知识库'),
          React.createElement('div', { style: { fontSize: 12, color: TOK.faint, marginLeft: 'auto' } }, '配置文件 ' + (cfg && cfg.configPath ? cfg.configPath : '-')),
          React.createElement('div', { style: { fontSize: 11, color: TOK.faint } }, rev ? 'r' + rev : '')),
        React.createElement('div', { style: { fontSize: 12, color: TOK.sub, marginTop: 4 } },
          '这些设置决定 dsh-AIkb 用哪个库、把工具链与知识包装到哪里，以及是否允许写回库内文件。'),

        React.createElement('div', { style: GROUP }, '知识库（单选决定当前库；保存后生效）'),
        vaultRows,
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
          React.createElement('button', { style: BTN, onClick: addVault, type: 'button' }, '添加知识库'),
          React.createElement('button', { style: BTN, onClick: function () { save(); }, type: 'button', disabled: busy }, '保存配置')),

        React.createElement('div', { style: GROUP }, '新建知识库（空目录；会写入 .obsidian、.dsh-aikb/schema.md、README 与 index）'),
        React.createElement('div', { style: CARD },
          React.createElement('label', { style: ROW },
            React.createElement('span', { style: LABEL }, '目录'),
            React.createElement('input', { style: INPUT, value: fresh.dir, placeholder: '/absolute/path/MyBase', onChange: function (e) { setFresh(Object.assign({}, fresh, { dir: e.target.value })); } })),
          React.createElement('label', { style: ROW },
            React.createElement('span', { style: LABEL }, '名称'),
            React.createElement('input', { style: INPUT, value: fresh.name, placeholder: '留空用目录名', onChange: function (e) { setFresh(Object.assign({}, fresh, { name: e.target.value })); } })),
          React.createElement('label', { style: ROW },
            React.createElement('span', { style: LABEL }, '模板'),
            React.createElement('select', {
              style: Object.assign({}, INPUT, { flex: '0 0 180px' }), value: fresh.template,
              onChange: function (e) { setFresh(Object.assign({}, fresh, { template: e.target.value })); },
            },
              React.createElement('option', { value: 'notes' }, 'notes（笔记 + sources）'),
              React.createElement('option', { value: 'books' }, 'books（书 + sources）'),
              React.createElement('option', { value: 'both' }, 'both（笔记 + 书 + sources）'),
              React.createElement('option', { value: 'blank' }, 'blank（只有约定与索引）'))),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
            React.createElement('button', { style: BTN, onClick: createVault, type: 'button', disabled: busy || !draft.allowWrites }, '新建并注册'),
            React.createElement('span', { style: { fontSize: 11, color: draft.allowWrites ? TOK.faint : TOK.warn, alignSelf: 'center' } },
              draft.allowWrites ? '写入已允许。' : '需要先打开「允许写入」并保存。'))),

        React.createElement('div', { style: GROUP }, '目录'),
        React.createElement('label', { style: ROW },
          React.createElement('span', { style: LABEL }, '知识包目录'),
          React.createElement('input', { style: INPUT, value: draft.packDir, placeholder: '例如 D:/knowledge/packs；留空用 ~/.dsh-aikb', onChange: function (e) { patchDraft('packDir', e.target.value); } })),
        React.createElement('label', { style: ROW },
          React.createElement('span', { style: LABEL }, '工具链目录'),
          React.createElement('span', { style: Object.assign({}, LABEL, { flex: 'none' }) }, '')),
        React.createElement('label', { style: ROW },
          React.createElement('span', { style: LABEL }, ''),
          React.createElement('input', { style: INPUT, value: draft.toolchainDir, placeholder: '留空用 ~/.dsh-aikb/toolchain（venv、OCR 与向量模型都在这里）', onChange: function (e) { patchDraft('toolchainDir', e.target.value); } })),
        React.createElement('label', { style: ROW },
          React.createElement('span', { style: LABEL }, '草稿提升目录'),
          React.createElement('input', { style: INPUT, value: draft.promoteDir, placeholder: '相对库根，例如 学习/笔记', onChange: function (e) { patchDraft('promoteDir', e.target.value); } })),

        React.createElement('div', { style: GROUP }, '开关'),
        toggle('allowWrites', '允许写入'),
        toggle('ocrEnabled', '扫描版 PDF 走 OCR'),
        toggle('embedEnabled', '向量检索'),
        toggle('embedOnIngest', '入库时顺带建向量'),
        toggle('rerankEnabled', '交叉编码重排'),
        React.createElement('label', { style: ROW },
          React.createElement('span', { style: LABEL }, 'OCR 并发'),
          React.createElement('input', {
            style: Object.assign({}, INPUT, { flex: '0 0 90px' }), type: 'number', min: 1, max: 32, value: draft.ocrWorkers,
            onChange: function (e) { patchDraft('ocrWorkers', Number(e.target.value) || 1); },
          })),

        React.createElement('div', { style: GROUP }, '库约定（页面规范 / 目录用途 / 加工流程；写在库内 .dsh-aikb/schema.md）'),
        React.createElement('textarea', {
          style: { width: '100%', boxSizing: 'border-box', minHeight: 160, padding: 8, fontSize: 12, lineHeight: 1.6, fontFamily: 'inherit', color: TOK.text, background: 'transparent', border: '1px solid ' + TOK.border, borderRadius: 6 },
          value: sheet.text,
          placeholder: sheet.loaded ? '' : '读取中…',
          onChange: function (e) { setSheet(Object.assign({}, sheet, { text: e.target.value })); },
        }),
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
          React.createElement('button', { style: BTN, onClick: saveSheet, type: 'button', disabled: busy || sheet.allowWrites === false }, '保存库约定'),
          React.createElement('span', { style: { fontSize: 11, color: TOK.faint } },
            sheet.allowWrites === false ? '只读模式：先打开写入并保存配置。' : (sheet.exists ? '已存在，保存会覆盖。' : '还没有这个文件，保存会按模板创建。'))),

        React.createElement('div', { style: GROUP }, '页面反馈（inbox/feedback.md；最多显示最近 20 条）'),
        (fbs.length === 0
          ? React.createElement('div', { style: { fontSize: 12, color: TOK.faint } }, '没有反馈。')
          : fbs.slice(-20).reverse().map(function (row) {
            return React.createElement('div', { key: row.index, style: Object.assign({}, CARD, { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }) },
              React.createElement('span', { style: { fontSize: 11, color: row.done ? TOK.ok : TOK.warn, flex: '0 0 48px' } }, row.done ? '已处理' : '待处理'),
              React.createElement('span', { style: { fontSize: 12, flex: 1 } }, row.note + ' — ' + row.text),
              React.createElement('span', { style: { fontSize: 11, color: TOK.faint } }, String(row.at || '').slice(0, 10)),
              row.done ? null : React.createElement('button', { style: BTN, type: 'button', onClick: function () { markDone(row.index); } }, '标为已处理'));
          })),

        React.createElement('div', {
          style: { marginTop: 16, padding: '8px 10px', fontSize: 12, whiteSpace: 'pre-wrap', borderRadius: 6, border: '1px solid ' + TOK.border, color: msg.kind === 'err' ? TOK.err : msg.kind === 'warn' ? TOK.warn : msg.kind === 'ok' ? TOK.ok : TOK.sub },
        }, msg.text));
    }

    function apply(ctx) {
      // Same strip as 对话/上下文/编队/调试台: the conversation.view slot.
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: ID,
        order: 40,
        label: () => '知识库',
      }, KbPage));
      // One page inside DSH Settings (the shell declares the slot; late mount is handled by inject).
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-aikb-settings',
        order: 120,
        label: () => '知识库',
      }, () => React.createElement(KbSettings)));
    }

    exports.name = 'dsh-aikb';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
