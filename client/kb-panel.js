/* dsh-kb panel — sidebar entry + main page (same slots as dsh-skill-mcp-panel). */
window.__ModuleLoader__.load({
  id: 'dsh-kb',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var ID = 'dsh-kb';
    var SRC = 'http://127.0.0.1:7317/';

    function KbIcon() {
      return React.createElement('span', { style: { fontSize: 15, lineHeight: 1 } }, '📚');
    }

    function KbPage() {
      return React.createElement('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { style: { padding: '8px 12px', borderBottom: '1px solid #2a2e36', fontSize: 12, color: '#8b96a8' } },
          'dsh-kb · 本地索引 ',
          React.createElement('a', { href: SRC, target: '_blank', rel: 'noreferrer', style: { color: '#9cc7ff' } }, SRC)),
        React.createElement('iframe', {
          src: SRC,
          title: 'dsh-kb',
          style: { flex: 1, width: '100%', border: '0', background: '#14161a' },
        }));
    }

    function apply(ctx) {
      // One sidebar row; its id is the main-page key, so selecting the row renders KbPage.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: ID,
        order: 1,
        label: () => '知识库',
      }, KbIcon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: ID,
      }, KbPage));
    }

    exports.name = 'kb-panel';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
