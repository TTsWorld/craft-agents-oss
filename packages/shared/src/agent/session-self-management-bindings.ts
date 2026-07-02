/**
 * Session 自管理回调绑定（session self-management bindings）
 *
 * 通过 Object.defineProperty 给 SessionToolContext 挂上若干 session 管理属性，
 * 使用的是「非缓存的 lazy getter」：每次访问都重新去 session-scoped tool
 * callback registry 里取最新的回调。
 *
 * 这样的好处：后续 merge 进来的回调、被替换掉的回调，无需重建 context 就能
 * 立刻对工具可见。类比 Go：相当于把一个 interface 字段做成方法调用，
 * 每次都查注册表而不是缓存第一次的结果。
 *
 * Claude 和 Pi 两条后端路径都用同一份绑定 —— #511 的根因就是 PiAgent 的 context
 * 漏挂了这些绑定。
 *
 * 设计原则：
 * - 每个 getter 都重新调用 getSessionScopedToolCallbacks()，不做任何 memoization
 * - 缺失回调时直接返回 undefined，绝不退化成 no-op，也绝不返回假数据
 * - 只有 getSessionInfo 做了包装（用于 sid ?? sessionId 的默认值处理）
 * - 其余字段签名与注册表回调一致，直接透传
 */

import type { SessionToolContext } from '@craft-agent/session-tools-core';
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';

/**
 * 把 session 自管理能力挂到 SessionToolContext 上。
 *
 * 用 lazy getter 注册以下属性：setSessionLabels、setSessionStatus、
 * getSessionInfo、listSessions、resolveLabels、resolveStatus 等。
 *
 * @param context  - 待增强的 SessionToolContext（会被原地修改）
 * @param sessionId - 用于查注册表、以及 getSessionInfo 默认 sid 时的兜底
 */
export function attachSessionSelfManagementBindings(
  context: SessionToolContext,
  sessionId: string,
): void {
  // 直接透传的绑定 —— 注册表回调签名和 context 字段完全一致，无需包装。
  // 每个 getter 都在每次访问时重新查注册表。

  Object.defineProperty(context, 'setSessionLabels', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.setSessionLabelsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'setSessionStatus', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.setSessionStatusFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'listSessions', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.listSessionsFn;
    },
    configurable: true,
    enumerable: true,
  });

  // listBackgroundTasks defaults sid → sessionId (like getSessionInfo)
  Object.defineProperty(context, 'listBackgroundTasks', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.listBackgroundTasksFn;
      if (!fn) return undefined;
      return (sid?: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'resolveLabels', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.resolveLabelsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'resolveStatus', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.resolveStatusFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'sendAgentMessage', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.sendAgentMessageFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'activateSourceInSession', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.activateSourceInSessionFn;
    },
    configurable: true,
    enumerable: true,
  });

  // 消息网关（messaging gateway）相关绑定 —— 需要在外层 sid 缺省时回退到当前 sessionId
  Object.defineProperty(context, 'getMessagingBindings', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.getMessagingBindingsFn;
      if (!fn) return undefined;
      return (sid: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'unbindMessagingChannel', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.unbindMessagingChannelFn;
      if (!fn) return undefined;
      return (sid: string, platform?: string) => fn(sid ?? sessionId, platform);
    },
    configurable: true,
    enumerable: true,
  });

  // getSessionInfo 需要包一层：未显式传 sid 时默认用当前 sessionId
  Object.defineProperty(context, 'getSessionInfo', {
    get() {
      const fn = getSessionScopedToolCallbacks(sessionId)?.getSessionInfoFn;
      if (!fn) return undefined;
      return (sid?: string) => fn(sid ?? sessionId);
    },
    configurable: true,
    enumerable: true,
  });
}
