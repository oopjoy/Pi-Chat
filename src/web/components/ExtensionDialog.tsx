import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "../../shared/types";

export type { ExtensionUiRequest } from "../../shared/types";

export function describeGateRequest(request: ExtensionUiRequest): { action: string; target: string } {
  const message = request.message || request.title || "";
  const bash = /Destructive bash command:\s*([\s\S]*?)(?:\n\nAllow\?|$)/i.exec(message)?.[1]?.trim();
  if (bash) return { action: "Pi 请求执行高风险命令", target: bash };
  const edit = /Edit\s+(.+)/i.exec(message)?.[1]?.trim();
  if (edit) return { action: "Pi 请求修改文件", target: edit };
  const write = /Write to\s+(.+)/i.exec(message)?.[1]?.trim();
  const deleting = /contains deletion/i.test(request.title || "");
  return { action: deleting ? "Pi 请求写入文件（含删除内容）" : "Pi 请求写入文件", target: write || message || "未提供操作详情" };
}

export function ExtensionDialog({ request, onRespond }: {
  request: ExtensionUiRequest | null;
  onRespond: (body: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(request?.prefill || ""), [request]);
  // Keep hook execution independent of whether a request exists. A previous
  // version conditionally called useMemo below the early return, so opening a
  // Session with a pending Gate request changed this component's hook count
  // and React crashed the entire app into a white page.
  const gatePrompt = Boolean(request && /(?:Write|Edit|Destructive bash|Allow\?)/i.test(request.title || ""));
  const gateDetails = request && gatePrompt ? describeGateRequest(request) : null;
  if (!request || !["select", "confirm", "input", "editor"].includes(request.method)) return null;

  const cancel = () => onRespond({ id: request.id, cancelled: true });
  const submit = () => {
    if (request.method === "confirm") onRespond({ id: request.id, confirmed: true });
    else onRespond({ id: request.id, value });
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className={`dialog ${gatePrompt ? "gate-confirmation" : ""}`} role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
        <h2 id="extension-dialog-title">{gatePrompt ? "文件权限确认" : request.title || "Pi 需要你的输入"}</h2>
        {gateDetails && <div className="gate-action-summary"><strong>{gateDetails.action}</strong><code title={gateDetails.target}>{gateDetails.target}</code></div>}
        {request.message && !gatePrompt && <p>{request.message}</p>}
        {gatePrompt && <p className="gate-confirmation-note">由文件权限保护拦截，确认后继续执行。</p>}
        {request.method === "select" && (
          <div className="dialog-options">
            {(request.options || []).map((option) => (
              <button type="button" className={gatePrompt && option.includes("Allow") ? "gate-allow" : gatePrompt ? "gate-block" : ""} key={option} onClick={() => onRespond({ id: request.id, value: option })}>{gatePrompt && option.includes("Allow") ? "允许执行" : gatePrompt ? "拒绝" : option}</button>
            ))}
          </div>
        )}
        {request.method === "input" && <input autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />}
        {request.method === "editor" && <textarea autoFocus rows={8} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />}
        <footer>
          <button type="button" onClick={cancel}>取消</button>
          {request.method !== "select" && <button type="button" className="primary" onClick={submit}>确定</button>}
        </footer>
      </section>
    </div>
  );
}
