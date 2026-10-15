/** Mobile wire DTOs. Keep this boundary independent of server/database modules. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AppCapabilities = {
  database: boolean;
  frontend: boolean;
  widgets: boolean;
  backend: boolean;
  cron: boolean;
  webhook: boolean;
  storage?: boolean;
  kv: boolean;
  dataTable?: boolean;
};
export type AppSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  capabilities: AppCapabilities | null;
  createdAt: string;
  updatedAt: string;
};
export type AppDetail = AppSummary & {
  deploymentRevision: string | null;
  compatibility: {
    version: number;
    latestVersion: number;
    minimumSupportedVersion: number;
    isSupported: boolean;
    isLatest: boolean;
  } | null;
};
export type Model = {
  id: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
};
export type MobileConfig = {
  apiVersion: 1;
  providers: { id: string; name: string; models: Model[] }[];
  defaultModel: { providerId: string; modelId: string } | null;
};
export type AskQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple: boolean;
};
export type AskAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  customText?: string;
};
export type PendingAsk = { askId: string; questions: AskQuestion[] };
export type PendingEnv = {
  requestId: string;
  reason: string;
  variables: { key: string; description: string; secret: boolean }[];
};
export type RunStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type ActiveRun = {
  id: string;
  status: RunStatus;
  startedAt: string;
  userTurn: number | null;
  pendingAsk: PendingAsk | null;
  answeredAskId?: string | null;
  pendingEnvRequest: PendingEnv | null;
};
export type SessionSummary = {
  id: string;
  title: string;
  appIds: string[];
  providerId: string | null;
  modelId: string | null;
  messageCount: number;
  updatedAt: string;
};
export type SessionDetail = Omit<SessionSummary, 'messageCount'> & {
  messages: JsonValue[];
  activeRun: ActiveRun | null;
  runs: {
    id: string;
    status: RunStatus;
    userTurn: number;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
  }[];
  serverTime: string;
};
export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};
export type CreateRunInput = {
  sessionId: string;
  providerId: string;
  modelId: string;
} & (
  | {
      retry?: false;
      content: { type: 'text'; text: string }[];
      images?: { data: string; mimeType: string }[];
      attachmentIds?: string[];
    }
  | { retry: true; expectedSessionUpdatedAt: string }
);
export type RunCreated = { runId: string; startedAt: string };
export type AppHandoff = {
  url: string;
  ticket: string;
  expiresAt: string;
  targetPath: string;
};

export type AgentStreamEvent =
  | { type: 'assistant_start' }
  | { type: 'text' | 'thinking'; delta: string }
  | ({ type: 'ask' } & PendingAsk)
  | { type: 'ask_answered'; askId: string }
  | ({ type: 'env_request' } & PendingEnv)
  | {
      type: 'env_stored';
      requestId: string;
      variables: { key: string; secret: boolean }[];
    }
  | {
      type: 'tool_start';
      id: string;
      name: string;
      label?: string;
      args: JsonValue;
      details?: JsonValue;
    }
  | { type: 'tool_update'; id: string; name: string; output: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      output?: string;
      details?: JsonValue;
      summary?: string;
    }
  | { type: 'turn_end' | 'cancelled' | 'done' }
  | { type: 'error'; message: string };
export type RunStreamEvent = { seq: number; event: AgentStreamEvent };
