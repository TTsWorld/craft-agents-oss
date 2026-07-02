/**
 * 全屏遮罩层动画的共享配置。
 * 不同组件使用同一套缓动曲线与过渡时长，保证动画节奏一致。
 */

// 进入动画的缓动曲线：expo-out（起步快、收尾缓，给人“跟手”的响应感）
export const overlayEaseIn = [0.16, 1, 0.3, 1] as const  // expo-out

// 退出动画的缓动曲线：expo-in（起步缓、加速离开，像被“拉走”）
export const overlayEaseOut = [0.7, 0, 0.84, 0] as const  // expo-in

// 进入动画的补间（tween）配置
export const overlayTransitionIn = {
  duration: 0.4,
  ease: overlayEaseIn,
}

// 退出动画的补间（tween）配置
export const overlayTransitionOut = {
  duration: 0.3,
  ease: overlayEaseOut,
}

// 遮罩打开时，主应用外壳向后退让的缩放/位移/圆角参数
export const scaleBackValues = {
  scale: 0.92,
  y: 20,
  borderRadius: 16,
}
