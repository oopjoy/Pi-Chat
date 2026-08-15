import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionUiRequest } from "../../shared/types";
import { useModalFocus } from "../lib/modal-focus";
import { ExtensionIcon, ShieldIcon } from "./Icons";

export type { ExtensionUiRequest } from "../../shared/types";

export interface GateRequestDetails {
  action: string;
  target: string;
  tool: string;
  allowValue: string;
  blockValue: string;
}

function gateAction(tool: string, deleting = false): string {
  if (tool === "bash") return "请求执行命令";
  if (tool === "edit") return "请求修改文件";
  if (tool === "write") return deleting ? "请求写入文件（含删除内容）" : "请求写入文件";
  return "请求执行受保护操作";
}

export function describeGateRequest(request: ExtensionUiRequest): GateRequestDetails | null {
  if (request.method !== "select") return null;
  const allowValue = (request.options || []).find((option) => /\ballow\b/i.test(option));
  const blockValue = (request.options || []).find((option) => /\bblock\b/i.test(option));
  if (!allowValue || !blockValue) return null;

  const title = (request.title || "").trim();
  const message = (request.message || "").trim();
  const protocol = /^Pi Chat Gate\s*[·:]\s*([a-z][\w-]*)(?:\s*[·:]\s*([^\n]+))?(?:\n+([\s\S]*))?$/i.exec(title);
  if (protocol) {
    const tool = protocol[1].toLowerCase();
    const deleting = /delet/i.test(protocol[2] || "");
    return { action: gateAction(tool, deleting), target: protocol[3]?.trim() || message || "未提供操作详情", tool, allowValue, blockValue };
  }

  const permission = /^Tool requires permission:\s*([a-z][\w-]*)\s*:?\s*([\s\S]*)$/i.exec(title);
  if (permission) {
    const tool = permission[1].toLowerCase();
    return { action: gateAction(tool), target: permission[2].trim() || message || "未提供操作详情", tool, allowValue, blockValue };
  }

  const source = [title, message].filter(Boolean).join("\n");
  const bash = /Destructive bash command:\s*([\s\S]*?)(?:\n\s*Allow\?|$)/i.exec(source)?.[1]?.trim();
  if (bash) return { action: "请求执行高风险命令", target: bash, tool: "bash", allowValue, blockValue };
  const edit = /(?:^|\n)\s*Edit\s+([^\n][\s\S]*)$/i.exec(source)?.[1]?.trim();
  if (edit) return { action: gateAction("edit"), target: edit, tool: "edit", allowValue, blockValue };
  const write = /Write to\s+([\s\S]+)$/i.exec(source)?.[1]?.trim();
  if (write) return { action: gateAction("write", /contains deletion/i.test(source)), target: write, tool: "write", allowValue, blockValue };
  return null;
}

export function ExtensionDialogFrame({ gate, title, children, actions }: {
  gate: boolean;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(true, dialogRef);
  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="dialog extension-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
        <header className="extension-dialog-header">
          <span className={`extension-dialog-icon ${gate ? "is-gate" : "is-extension"}`}>
            {gate ? <ShieldIcon /> : <ExtensionIcon />}
          </span>
          <div>
            <span>{gate ? "Pi Chat Gate" : "Pi Extension"}</span>
            <h2 id="extension-dialog-title">{title}</h2>
          </div>
        </header>
        <div className="extension-dialog-body">{children}</div>
        <footer className="extension-dialog-actions">{actions}</footer>
      </section>
    </div>
  );
}

export function ExtensionDialog({
  request,
  sessionId = null,
  continuationPending = false,
  disabled = false,
  onRespond,
}: {
  request: ExtensionUiRequest | null;
  sessionId?: string | null;
  /** Keep one visual frame while an active Extension tool replaces one scalar RPC dialog with the next. */
  continuationPending?: boolean;
  disabled?: boolean;
  onRespond: (body: { id?: string; cancelled?: boolean; confirmed?: boolean; value?: string }) => void;
}) {
  const [value, setValue] = useState("");
  const [submittedRequestId, setSubmittedRequestId] = useState<string | null>(null);
  const [continuity, setContinuity] = useState<{
    sessionId: string;
    request: ExtensionUiRequest;
  } | null>(null);
  const activeRequest = request && ["select", "confirm", "input", "editor"].includes(request.method)
    ? request
    : null;
  const continuitySessionId = sessionId || activeRequest?.piChatSessionId || "";

  useEffect(() => {
    if (activeRequest) {
      // Gate is a safety decision, not a questionnaire step. It should close as
      // soon as its one response is accepted rather than linger as a wizard.
      setContinuity(describeGateRequest(activeRequest)
        ? null
        : { sessionId: continuitySessionId, request: activeRequest });
      setSubmittedRequestId(null);
      return;
    }
    if (!continuationPending) {
      setContinuity(null);
      setSubmittedRequestId(null);
    }
  }, [activeRequest, continuationPending, continuitySessionId]);

  const continuityRequest = continuity?.sessionId === continuitySessionId
    ? continuity.request
    : null;
  const visibleRequest = activeRequest || (continuationPending ? continuityRequest : null);
  const gateDetails = useMemo(
    () => visibleRequest ? describeGateRequest(visibleRequest) : null,
    [visibleRequest],
  );
  const submitted = Boolean(
    visibleRequest && submittedRequestId === visibleRequest.id,
  );
  const continuing = Boolean(
    !gateDetails && visibleRequest && (submitted || !activeRequest),
  );
  const interactionDisabled = disabled || submitted || !activeRequest;

  useEffect(() => setValue(activeRequest?.prefill || ""), [activeRequest]);
  useEffect(() => {
    if (!activeRequest) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || interactionDisabled) return;
      event.preventDefault();
      setSubmittedRequestId(activeRequest.id);
      if (gateDetails)
        onRespond({ id: activeRequest.id, value: gateDetails.blockValue });
      else onRespond({ id: activeRequest.id, cancelled: true });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeRequest, gateDetails, interactionDisabled, onRespond]);

  if (!visibleRequest) return null;

  const respond = (body: { id?: string; cancelled?: boolean; confirmed?: boolean; value?: string }) => {
    if (interactionDisabled || !activeRequest) return;
    setSubmittedRequestId(activeRequest.id);
    onRespond(body);
  };
  const cancel = () => respond({ id: visibleRequest.id, cancelled: true });
  const submit = () => {
    if (visibleRequest.method === "confirm")
      respond({ id: visibleRequest.id, confirmed: true });
    else respond({ id: visibleRequest.id, value });
  };

  if (gateDetails) {
    return (
      <ExtensionDialogFrame
        gate
        title="权限确认"
        actions={
          <>
            <button type="button" className="gate-block" autoFocus disabled={interactionDisabled} onClick={() => respond({ id: visibleRequest.id, value: gateDetails.blockValue })}>Block</button>
            <button type="button" className="gate-allow" disabled={interactionDisabled} onClick={() => respond({ id: visibleRequest.id, value: gateDetails.allowValue })}>Allow</button>
          </>
        }
      >
        <div className="gate-request-heading"><strong>{gateDetails.action}</strong><span>{gateDetails.tool}</span></div>
        <pre className="gate-request-target"><code>{gateDetails.target}</code></pre>
        <p className="gate-confirmation-note">Gate 严格模式已拦截此操作。只有 Allow 后，Pi 才会继续执行。</p>
      </ExtensionDialogFrame>
    );
  }

  return (
    <ExtensionDialogFrame
      gate={false}
      title={visibleRequest.title || "Pi 需要你的输入"}
      actions={continuing
        ? <span className="extension-dialog-continuation-status" role="status">已提交，正在准备下一步…</span>
        : (
          <>
            <button type="button" disabled={interactionDisabled} onClick={cancel}>取消</button>
            {visibleRequest.method !== "select" && <button type="button" className="primary" disabled={interactionDisabled} onClick={submit}>确定</button>}
          </>
        )}
    >
      {continuing ? (
        <div className="extension-dialog-continuation" aria-live="polite">
          <span aria-hidden="true" />
          <p>保持当前对话框，等待 Pi 提供下一步输入。</p>
        </div>
      ) : (
        <>
          {visibleRequest.message && <p className="extension-dialog-message">{visibleRequest.message}</p>}
          {visibleRequest.method === "select" && (
            <div className="dialog-options">
              {(visibleRequest.options || []).map((option) => <button type="button" key={option} disabled={interactionDisabled} onClick={() => respond({ id: visibleRequest.id, value: option })}>{option}</button>)}
            </div>
          )}
          {visibleRequest.method === "input" && <input autoFocus disabled={interactionDisabled} value={value} placeholder={visibleRequest.placeholder} onChange={(event) => setValue(event.target.value)} />}
          {visibleRequest.method === "editor" && <textarea autoFocus disabled={interactionDisabled} rows={8} value={value} placeholder={visibleRequest.placeholder} onChange={(event) => setValue(event.target.value)} />}
        </>
      )}
    </ExtensionDialogFrame>
  );
}
