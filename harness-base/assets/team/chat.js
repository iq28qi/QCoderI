// A conversation preset has no project tools, shell, or delegation capability.
export const name = 'qcoderi-chat';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] });
}
