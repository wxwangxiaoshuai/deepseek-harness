/** Add the owner workbench entry to the DSH browser sidebar. */
window.__ModuleLoader__.load({
  id: 'dsh-renovation-workbench',
  factory(require) {
    const { createElement } = require('react')
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('renovationWorkbench', {
          zh: { title: '装修项目工作台' },
          en: { title: 'Renovation workbench' },
        }))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'renovation-workbench', locale: 'renovationWorkbench',
        }, ({ t }) => createElement('a', { href: '/renovation-workbench/', target: '_blank', rel: 'noreferrer', title: t('title') }, t('title'))))
      },
    }
  },
})
