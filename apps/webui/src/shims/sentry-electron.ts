/** @sentry/electron/renderer 的浏览器垫片：浏览器构建里不做任何上报。 */
export function init(..._args: any[]) {}
export const captureException = () => {}
export const captureMessage = () => {}
export const ErrorBoundary = ({ children }: { children: React.ReactNode; fallback?: React.ReactNode }) => children
