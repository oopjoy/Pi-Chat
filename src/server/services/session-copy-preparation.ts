import { HttpRequestError } from "../http-transport.js";

export interface SessionCopyPreparationInput {
  mode: "clone" | "fork";
  sourcePath?: string;
  summary?: { name: string };
  draft: boolean;
  primary: boolean;
  primaryBusy: boolean;
  secondaryBusy: boolean;
  forkTargetAvailable: boolean;
}

/** Validate copy/fork source readiness without owning Runtime or Session state. */
export function validateSessionCopyPreparation(input: SessionCopyPreparationInput): { sourcePath: string; summary: { name: string } } {
  if (input.draft)
    throw new HttpRequestError(409, "空白新对话发送第一条消息后才能复制");
  if (!input.sourcePath || !input.summary)
    throw new HttpRequestError(404, "会话不存在或尚未持久化");
  if (input.primary ? input.primaryBusy : input.secondaryBusy)
    throw new HttpRequestError(
      409,
      "请等待当前生成、压缩、确认和队列全部结束后再复制会话",
    );
  if (input.mode === "fork" && !input.forkTargetAvailable)
    throw new HttpRequestError(
      409,
      "只能从当前分支中已持久化的文字或图片 User 消息创建新对话",
    );
  return { sourcePath: input.sourcePath, summary: input.summary };
}
