import { useEffect, useState } from "react";

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  piChatSessionId?: string;
}

export function ExtensionDialog({ request, onRespond }: {
  request: ExtensionUiRequest | null;
  onRespond: (body: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(request?.prefill || ""), [request]);
  if (!request || !["select", "confirm", "input", "editor"].includes(request.method)) return null;
  const gatePrompt = /(?:Write|Edit|Destructive bash|Allow\?)/i.test(request.title || "");

  const cancel = () => onRespond({ id: request.id, cancelled: true });
  const submit = () => {
    if (request.method === "confirm") onRespond({ id: request.id, confirmed: true });
    else onRespond({ id: request.id, value });
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className={`dialog ${gatePrompt ? "gate-confirmation" : ""}`} role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
        <h2 id="extension-dialog-title">{gatePrompt ? "文件权限确认" : request.title || "Pi 需要你的输入"}</h2>
        {gatePrompt && <p className="gate-confirmation-note">此操作由 Pi 的文件权限 Gate 拦截；只有选择允许后，Pi 才会继续执行。</p>}
        {request.message && <p>{request.message}</p>}
        {request.method === "select" && (
          <div className="dialog-options">
            {(request.options || []).map((option) => (
              <button type="button" className={gatePrompt && option.includes("Allow") ? "gate-allow" : gatePrompt ? "gate-block" : ""} key={option} onClick={() => onRespond({ id: request.id, value: option })}>{option}</button>
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
