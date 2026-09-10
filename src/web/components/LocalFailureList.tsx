import type { LocalFailureNotice } from "../../shared/assistant-error";

/**
 * Persistent in-transcript record of the Runtime failures that never produced an
 * assistant message. The transient toast cannot carry this: it disappears after
 * five seconds, leaving the user unable to tell why a turn stopped.
 */
export function LocalFailureList({ failures }: { failures: LocalFailureNotice[] }) {
  if (!failures.length) return null;
  return <>{failures.map((failure) => (
    <article className="message message-assistant message-local-failure" key={failure.id}>
      <div className="message-content">
        <div className="message-error" role="status">
          <strong className="message-error-title">{failure.title}</strong>
          <p className="message-error-detail">{failure.detail}</p>
          {/* These entries sit at the end of the transcript, so the time keeps an
              older failure from reading as part of the newest turn. */}
          <span className="message-error-time">{failureTime(failure.at)}</span>
        </div>
      </div>
    </article>
  ))}</>;
}

function failureTime(at: number): string {
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
