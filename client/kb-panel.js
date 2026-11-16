/* dsh-kb — a workspace tab (conversation.view) that hosts the knowledge-base UI. */
window.__ModuleLoader__.load({
  id: 'dsh-kb',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var ID = 'dsh-kb';
    var SRC = 'http://127.0.0.1:7341/';

    function KbPage() {
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        React.createElement('div', { style: { padding: '8px 12px', borderBottom: '1px solid #2a2e36', fontSize: 12, color: '#8b96a8' } },
          'dsh-kb · ',
          React.createElement('a', { href: SRC, target: '_blank', rel: 'noreferrer', style: { color: '#9cc7ff' } }, '在新页打开')),
        React.createElement('iframe', {
          src: SRC,
          title: 'dsh-kb',
          style: { flex: 1, width: '100%', border: '0', background: '#14161a' },
        }));
    }

    function apply(ctx) {
      // Same strip as 对话/上下文/编队/调试台: the conversation.view slot.
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: ID,
        order: 40,
        label: () => '知识库',
      }, KbPage));
    }

    exports.name = 'kb-panel';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
