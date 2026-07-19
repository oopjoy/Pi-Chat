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
}

export function ExtensionDialog({ request, onRespond }: {
  request: ExtensionUiRequest | null;
  onRespond: (body: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(request?.prefill || ""), [request]);
  if (!request || !["select", "confirm", "input", "editor"].includes(request.method)) return null;

  const cancel = () => onRespond({ id: request.id, cancelled: true });
  const submit = () => {
    if (request.method === "confirm") onRespond({ id: request.id, confirmed: true });
    else onRespond({ id: request.id, value });
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
        <h2 id="extension-dialog-title">{request.title || "Pi 需要你的输入"}</h2>
        {request.message && <p>{request.message}</p>}
        {request.method === "select" && (
          <div className="dialog-options">
            {(request.options || []).map((option) => (
              <button type="button" key={option} onClick={() => onRespond({ id: request.id, value: option })}>{option}</button>
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
