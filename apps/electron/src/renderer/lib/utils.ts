/**
 * Tailwind CSS 类名合并工具。
 *
 * 先用 clsx 合并条件类名，再用 tailwind-merge 解决 Tailwind 类名冲突。
 * 这是 React + Tailwind 项目中的常见工具函数。
 */

import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
