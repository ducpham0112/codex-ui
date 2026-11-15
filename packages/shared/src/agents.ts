export type AgentId = 'codex' | 'claude';
export type ClaudeModel = 'default' | 'sonnet' | 'opus' | 'haiku';
export interface ClaudeAccount {
  status: 'unknown' | 'ready' | 'signed_out' | 'unavailable' | 'error';
  available: boolean;
  loggedIn?: boolean;
  version?: string;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  checkedAt?: string;
  error?: string;
  loginInstructions: string;
  apiBillingConfigured?: boolean;
}
export interface ClaudeUsage {
  status: 'unavailable';
  source: 'claude-cli';
  message: string;
  usageUrl: string;
  observedLimit?: { status?: string; resetsAt?: number; observedAt: string };
}
export interface ClaudeApproval {
  requestKey: string;
  requestId: string;
  sessionId: string;
  generation: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  reason?: string;
  createdAt: string;
}
export interface ClaudeItem {
  id: string;
  kind: 'message' | 'tool';
  role?: 'user' | 'assistant';
  text?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  createdAt: string;
}
export interface ClaudeSession {
  id: string;
  agentId: 'claude';
  nativeSessionId: string;
  projectId: string;
  projectRoot: string;
  title: string;
  model: ClaudeModel;
  status: 'idle' | 'running' | 'awaiting_approval' | 'interrupted' | 'error';
  createdAt: string;
  updatedAt: string;
  items: ClaudeItem[];
  approvals: ClaudeApproval[];
  error?: string;
}
export interface ClaudeSnapshot {
  account: ClaudeAccount;
  sessions: ClaudeSession[];
  usage: ClaudeUsage;
}
