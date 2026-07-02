/** 最近工作目录 mock 数据场景 */
export type RecentDirScenario = 'none' | 'few' | 'many'

/** 不同场景下的最近工作目录示例数据 */
const RECENT_DIR_SCENARIO_DATA: Record<RecentDirScenario, string[]> = {
  none: [],
  few: [
    '/Users/demo/projects/craft-agent',
    '/Users/demo/projects/craft-agent/apps/electron',
    '/Users/demo/projects/craft-agent/packages/shared',
  ],
  many: [
    '/Users/demo/projects/craft-agent',
    '/Users/demo/projects/craft-agent/apps/electron',
    '/Users/demo/projects/craft-agent/apps/viewer',
    '/Users/demo/projects/craft-agent/apps/cli',
    '/Users/demo/projects/craft-agent/packages/shared',
    '/Users/demo/projects/craft-agent/packages/server-core',
    '/Users/demo/projects/craft-agent/packages/pi-agent-server',
    '/Users/demo/projects/craft-agent/packages/ui',
    '/Users/demo/projects/craft-agent/scripts',
  ],
}

/** 返回指定场景下最近工作目录示例的副本 */
export function getRecentDirsForScenario(scenario: RecentDirScenario): string[] {
  return [...RECENT_DIR_SCENARIO_DATA[scenario]]
}
