import { onUnmounted } from 'vue'

const checks = new Set()

/** 组件只登记自己的未保存输入，离开页面时自动移除。 */
export function useUnsavedChanges(check) {
  checks.add(check)
  onUnmounted(() => checks.delete(check))
}

export function hasUnsavedChanges() {
  return [...checks].some((check) => check())
}
