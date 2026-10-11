export default {
  meta: { name: 'local' },
  rules: {
    'no-dynamic-import': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow dynamic import() expressions.' },
        messages: {
          banned: 'Dynamic import() is not allowed. Use a static import.',
        },
        schema: [],
      },
      create(context) {
        return {
          ImportExpression(node) {
            context.report({ node, messageId: 'banned' });
          },
        };
      },
    },
  },
};
