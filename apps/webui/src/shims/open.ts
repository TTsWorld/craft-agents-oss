/** 'open' npm 包的浏览器垫片：用 window.open 打开外部链接。 */
export default function open(target: string) {
  window.open(target, '_blank', 'noopener,noreferrer')
  return Promise.resolve({ pid: 0 } as any)
}
