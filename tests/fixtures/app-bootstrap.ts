import type { BootstrapData, SessionViewData } from "../../src/shared/types";

export const activeSessionId = "0123456789abcdefabcd";

export function createBootstrapFixture(): BootstrapData {
  return {
    state: {
      model: {
        id: "model",
        name: "Model",
        provider: "test",
        input: ["text"],
        reasoning: true,
      },
      thinkingLevel: "medium",
      isStreaming: false,
      sessionId: "active",
      sessionFile: "C:/sessions/active.jsonl",
    },
    messages: [],
    sessions: [
      {
        id: activeSessionId,
        sessionId: "active",
        name: "Active",
        preview: "",
        cwd: "C:/work",
        updatedAt: 1,
        messageCount: 1,
        active: true,
        writable: true,
      },
    ],
    models: [
      { id: "model", name: "Model", provider: "test", input: ["text"] },
    ],
    commands: [],
    queue: [],
    queuePaused: false,
    workspaceCwd: "C:/work",
    workspaceEpoch: "epoch-a",
    activeSessionId,
    activeSessionIds: [activeSessionId],
    applicationLifecycle: "idle",
    primaryRuntime: {
      status: "ready",
      generation: 0,
      model: {
        id: "model",
        name: "Model",
        provider: "test",
        input: ["text"],
        reasoning: true,
      },
      thinkingLevel: "medium",
      sessionId: activeSessionId,
    },
  };
}

export function createSessionViewFixture(): SessionViewData {
  const bootstrap = createBootstrapFixture();
  return {
    session: {
      id: "fedcba9876543210abcd",
      sessionId: "draft",
      name: "新对话",
      preview: "尚未发送消息",
      cwd: "C:/work",
      updatedAt: 2,
      messageCount: 0,
      active: false,
      writable: true,
    },
    state: {
      ...bootstrap.state,
      model: bootstrap.state.model ? { ...bootstrap.state.model } : null,
      sessionId: "draft",
      sessionFile: "C:/sessions/draft.jsonl",
      messageCount: 0,
    },
    messages: [],
    messageTotal: 0,
    messagesTruncated: false,
    isActive: true,
    runtimeStatus: "active",
    isStreaming: false,
    queue: [],
    queuePaused: false,
  };
}
