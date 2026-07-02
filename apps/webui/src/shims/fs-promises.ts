/** fs/promises 浏览器垫片：浏览器没有文件系统 API，这些方法会抛出错误或空操作。 */
export const readFile = async () => { throw new Error('fs.promises not available in browser') }
export const writeFile = async () => { throw new Error('fs.promises not available in browser') }
export const mkdir = async () => {}
export const readdir = async () => []
export const stat = async () => { throw new Error('fs.promises not available in browser') }
export const access = async () => { throw new Error('fs.promises not available in browser') }
export const rm = async () => {}
export const unlink = async () => {}
export const rename = async () => {}
export const copyFile = async () => {}
export default { readFile, writeFile, mkdir, readdir, stat, access, rm, unlink, rename, copyFile }
