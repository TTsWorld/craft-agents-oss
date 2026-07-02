/**
 * craft-agent CLI 的“域（domain）”策略定义。
 *
 * 每个域对应一组命令（label / source / skill / automation / permission / theme），
 * 并声明它管理哪些 workspace 相对路径、哪些只读操作，以及是否在直接执行 Bash
 * 时进行额外保护。类似于 Go 里把命令分组和权限策略放在一起的配置表。
 */

/** CLI 域命名空间联合类型：每个值代表一类 craft-agent 子命令 */
export type CliDomainNamespace = 'label' | 'source' | 'skill' | 'automation' | 'permission' | 'theme'

/** 单个 CLI 域的策略（类似 Go struct） */
export interface CliDomainPolicy {
  /** 域命名空间 */
  namespace: CliDomainNamespace
  /** 查看该域帮助用的命令 */
  helpCommand: string
  /** 该域拥有/管理的 workspace 相对路径通配 */
  workspacePathScopes: string[]
  /** 该域下视为只读、可在 Explore 模式直接执行的 action */
  readActions: string[]
  /** 给 AI 看的快速示例命令 */
  quickExamples: string[]
  /** 直接 Bash 操作时要额外保护的 workspace 相对路径（可选） */
  bashGuardPaths?: string[]
}

/**
 * 各 CLI 域的策略表。
 * key 是 CliDomainNamespace，value 是该域的元数据和路径范围。
 */
const POLICIES: Record<CliDomainNamespace, CliDomainPolicy> = {
  label: {
    namespace: 'label',
    helpCommand: 'craft-agent label --help',
    workspacePathScopes: ['labels/**'],
    readActions: ['list', 'get', 'auto-rule-list', 'auto-rule-validate'],
    quickExamples: [
      'craft-agent label list',
      'craft-agent label create --name "Bug" --color "accent"',
      'craft-agent label update bug --json \'{"name":"Bug Report"}\'',
    ],
    bashGuardPaths: ['labels/**'],
  },
  source: {
    namespace: 'source',
    helpCommand: 'craft-agent source --help',
    workspacePathScopes: ['sources/**'],
    readActions: ['list', 'get', 'validate', 'test', 'auth-help'],
    quickExamples: [
      'craft-agent source list',
      'craft-agent source get <slug>',
      'craft-agent source update <slug> --json "{...}"',
      'craft-agent source validate <slug>',
    ],
  },
  skill: {
    namespace: 'skill',
    helpCommand: 'craft-agent skill --help',
    workspacePathScopes: ['skills/**'],
    readActions: ['list', 'get', 'validate', 'where'],
    quickExamples: [
      'craft-agent skill list',
      'craft-agent skill get <slug>',
      'craft-agent skill update <slug> --json "{...}"',
      'craft-agent skill validate <slug>',
    ],
  },
  automation: {
    namespace: 'automation',
    helpCommand: 'craft-agent automation --help',
    workspacePathScopes: ['automations.json', 'automations-history.jsonl'],
    readActions: ['list', 'get', 'validate', 'history', 'last-executed', 'test', 'lint'],
    quickExamples: [
      'craft-agent automation list',
      'craft-agent automation create --event UserPromptSubmit --prompt "Summarize this prompt"',
      'craft-agent automation update <id> --json "{\"enabled\":false}"',
      'craft-agent automation history <id> --limit 20',
      'craft-agent automation validate',
    ],
    bashGuardPaths: ['automations.json', 'automations-history.jsonl'],
  },
  permission: {
    namespace: 'permission',
    helpCommand: 'craft-agent permission --help',
    workspacePathScopes: ['permissions.json', 'sources/*/permissions.json'],
    readActions: ['list', 'get', 'validate'],
    quickExamples: [
      'craft-agent permission list',
      'craft-agent permission get --source linear',
      'craft-agent permission add-mcp-pattern "list" --comment "All list ops" --source linear',
      'craft-agent permission validate',
    ],
    bashGuardPaths: ['permissions.json', 'sources/*/permissions.json'],
  },
  theme: {
    namespace: 'theme',
    helpCommand: 'craft-agent theme --help',
    workspacePathScopes: ['config.json', 'theme.json', 'themes/*.json'],
    readActions: ['get', 'validate', 'list-presets', 'get-preset'],
    quickExamples: [
      'craft-agent theme get',
      'craft-agent theme list-presets',
      'craft-agent theme set-color-theme nord',
      'craft-agent theme set-workspace-color-theme default',
      'craft-agent theme set-override --json "{\"accent\":\"#3b82f6\"}"',
    ],
    bashGuardPaths: ['config.json', 'theme.json', 'themes/*.json'],
  },
}

/** 导出只读的域策略表 */
export const CLI_DOMAIN_POLICIES = POLICIES

/** 带命名空间的路径范围条目 */
export interface CliDomainScopeEntry {
  namespace: CliDomainNamespace
  scope: string
}

/** 去重路径通配列表 */
function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)]
}

/**
 * craft-agent CLI 拥有的标准 workspace 相对路径范围。
 * 用于文件归属检查，避免各个调用点各自维护一份通配列表而漂移。
 */
export const CRAFT_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.workspacePathScopes)
)

/**
 * craft-agent CLI 直接 Bash 操作时需要保护的标准路径范围。
 */
export const CRAFT_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.bashGuardPaths ?? [])
)

/**
 * 带命名空间标注的 workspace 路径范围条目。
 */
export const CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => policy.workspacePathScopes.map(scope => ({ namespace: policy.namespace, scope })))

/**
 * 带命名空间标注的 Bash 保护路径条目。
 */
export const CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => (policy.bashGuardPaths ?? []).map(scope => ({ namespace: policy.namespace, scope })))

/** Bash 正则规则 */
export interface BashPatternRule {
  pattern: string
  comment: string
}

/**
 * 根据 CLI 域策略生成 Explore 模式下允许的只读 craft-agent Bash 正则。
 * 这样权限文件里的 regex 会和 CLI 命令元数据保持同步。
 */
export function getCraftAgentReadOnlyBashPatterns(): BashPatternRule[] {
  const namespaces = Object.keys(POLICIES) as CliDomainNamespace[]
  const namespaceAlternation = namespaces.join('|')

  // 为每个域生成其只读 action 对应的正则
  const rules: BashPatternRule[] = namespaces.map((namespace) => {
    const policy = POLICIES[namespace]
    const actions = policy.readActions.join('|')
    return {
      pattern: `^craft-agent\\s+${namespace}\\s+(${actions})\\b`,
      comment: `craft-agent ${namespace} read-only operations`,
    }
  })

  // 补充 bare invocation、子命令 help、--help 等安全场景
  rules.push(
    { pattern: '^craft-agent\\s*$', comment: 'craft-agent bare invocation (prints help)' },
    { pattern: `^craft-agent\\s+(${namespaceAlternation})\\s*$`, comment: 'craft-agent entity help' },
    { pattern: `^craft-agent\\s+(${namespaceAlternation})\\s+--help\\b`, comment: 'craft-agent entity help flags' },
    { pattern: '^craft-agent\\s+--(help|version|discover)\\b', comment: 'craft-agent global flags' },
  )

  return rules
}

/** 获取指定域的完整策略 */
export function getCliDomainPolicy(namespace: CliDomainNamespace): CliDomainPolicy {
  return POLICIES[namespace]
}
