import { AppError } from '../errors.js';

function compile(pattern) {
  const keys = [];
  const text = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${text}$`), keys };
}

/**
 * 极简路由表：只支持 :param，不做通配与嵌套。
 */
export function createRouter() {
  const routes = [];

  return {
    /**
     * @param {string} method
     * @param {string} pattern
     * @param {(ctx: {
     *   req: import('node:http').IncomingMessage,
     *   res: import('node:http').ServerResponse,
     *   url: URL,
     *   params: Record<string, string>,
     * }) => unknown} handler
     */
    add(method, pattern, handler) {
      const { regex, keys } = compile(pattern);
      routes.push({ method, regex, keys, handler });
    },

    /**
     * @param {string} method
     * @param {string} pathname
     * @returns {{ handler: Function, params: Record<string, string> } | null}
     */
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) {
          continue;
        }
        const found = route.regex.exec(pathname);
        if (!found) {
          continue;
        }
        const params = {};
        for (let index = 0; index < route.keys.length; index += 1) {
          try {
            params[route.keys[index]] = decodeURIComponent(found[index + 1]);
          } catch (err) {
            throw new AppError('path_invalid', '地址不合法', { status: 400, cause: err });
          }
        }
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}
