/* dsh-kb panel — right sidebar tab over the local search UI. */
window.__ModuleLoader__.load({
  id: 'dsh-kb',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var ID = 'dsh-kb';
    var SRC = 'http://127.0.0.1:7317/';

    function KbBody(props) {
      // The tab is opened for a file; its address lets the server find the nearest .dsh-kb.json.
      var address = (props && (props.address || props.path || props.file)) || '';
      var src = address === '' ? SRC : SRC + '?address=' + encodeURIComponent(address);
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        React.createElement('div', { style: { padding: '8px 12px', borderBottom: '1px solid #2a2e36', fontSize: 12, color: '#8b96a8' } },
          'dsh-kb · ', address === '' ? '默认库' : address,
          ' ', React.createElement('a', { href: SRC, target: '_blank', rel: 'noreferrer', style: { color: '#9cc7ff' } }, '打开')),
        React.createElement('iframe', {
          src: src,
          title: 'dsh-kb',
          style: { flex: 1, width: '100%', border: '0', background: '#14161a' },
        }));
    }

    function KbTitle() {
      return React.createElement('span', { style: { fontSize: 13 } }, '知识库');
    }

    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: 'kb',
        patterns: ['**/*'],
        title: () => '知识库',
        guide: [{ order: 40, title: () => '知识库', description: () => '在书库里检索、看章节原文' }],
      }));
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, KbBody)));
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, KbTitle)));
    }

    exports.name = 'kb-panel';
    exports.inject = ['slots', 'sidebarRightTabs'];
    exports.apply = apply;
    return module.exports;
  },
});
