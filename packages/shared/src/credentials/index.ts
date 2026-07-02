/**
 * 凭证（Credential）存储模块入口
 *
 * 提供基于 AES-256-GCM 加密文件的安全凭证存储。
 * 所有方法都会自动初始化，因此显式调用 initialize() 是可选的。
 *
 * 用法：
 *   import { getCredentialManager } from './credentials';
 *
 *   const manager = getCredentialManager();
 *
 *   // 获取/设置 API key
 *   const apiKey = await manager.getApiKey();
 *   await manager.setApiKey('sk-ant-...');
 *
 *   // 获取/设置 Workspace OAuth
 *   const oauth = await manager.getWorkspaceOAuth(workspaceId);
 *   await manager.setWorkspaceOAuth(workspaceId, { accessToken, refreshToken, ... });
 *
 *   // 获取/设置 Agent MCP/API 凭证
 *   const mcpCreds = await manager.getMcpOAuth(wsId, agentId, serverName);
 *   const apiKey = await manager.getApiKeyForAgent(wsId, agentId, apiName);
 */

export { CredentialManager, getCredentialManager } from './manager.ts';
export type { CredentialId, CredentialType, StoredCredential } from './types.ts';
export { credentialIdToAccount, accountToCredentialId, SOURCE_CREDENTIAL_TYPES } from './types.ts';
export type { CredentialBackend } from './backends/types.ts';
