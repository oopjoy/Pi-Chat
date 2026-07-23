import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "../../shared/types";
import { ShieldIcon } from "./Icons";

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

export function ExtensionDialog({ request, onRespond }: {
  request: ExtensionUiRequest | null;
  onRespond: (body: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState("");
  const gateDetails = request ? describeGateRequest(request) : null;
  useEffect(() => setValue(request?.prefill || ""), [request]);
  useEffect(() => {
    if (!request || !gateDetails) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onRespond({ id: request.id, value: gateDetails.blockValue });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [gateDetails, onRespond, request]);
  if (!request || !["select", "confirm", "input", "editor"].includes(request.method)) return null;

  const cancel = () => onRespond({ id: request.id, cancelled: true });
  const submit = () => {
    if (request.method === "confirm") onRespond({ id: request.id, confirmed: true });
    else onRespond({ id: request.id, value });
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className={`dialog ${gateDetails ? "gate-confirmation" : ""}`} role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
        {gateDetails ? (
          <>
            <header className="gate-dialog-header">
              <span className="gate-dialog-icon"><ShieldIcon /></span>
              <div><span>Pi Chat Gate</span><h2 id="extension-dialog-title">权限确认</h2></div>
            </header>
            <div className="gate-request-heading"><strong>{gateDetails.action}</strong><span>{gateDetails.tool}</span></div>
            <pre className="gate-request-target"><code>{gateDetails.target}</code></pre>
            <p className="gate-confirmation-note">Gate 严格模式已拦截此操作。只有 Allow 后，Pi 才会继续执行。</p>
            <footer className="gate-dialog-actions">
              <button type="button" className="gate-block" autoFocus onClick={() => onRespond({ id: request.id, value: gateDetails.blockValue })}>Block</button>
              <button type="button" className="gate-allow" onClick={() => onRespond({ id: request.id, value: gateDetails.allowValue })}>Allow</button>
            </footer>
          </>
        ) : (
          <>
            <h2 id="extension-dialog-title">{request.title || "Pi 需要你的输入"}</h2>
            {request.message && <p>{request.message}</p>}
            {request.method === "select" && (
              <div className="dialog-options">
                {(request.options || []).map((option) => <button type="button" key={option} onClick={() => onRespond({ id: request.id, value: option })}>{option}</button>)}
              </div>
            )}
            {request.method === "input" && <input autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />}
            {request.method === "editor" && <textarea autoFocus rows={8} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />}
            <footer>
              <button type="button" onClick={cancel}>取消</button>
              {request.method !== "select" && <button type="button" className="primary" onClick={submit}>确定</button>}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
