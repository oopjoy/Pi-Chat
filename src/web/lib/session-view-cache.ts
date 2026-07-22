import type { SessionViewData } from "../../shared/types";

export type SessionViewSnapshot = SessionViewData & { cachedAt: number };

export class SessionViewCache {
  private readonly views = new Map<string, SessionViewSnapshot>();

  constructor(private readonly limit = 5, private readonly now: () => number = Date.now) {}

  remember(view: SessionViewData): void {
    this.views.delete(view.session.id);
    this.views.set(view.session.id, { ...view, cachedAt: this.now() });
    while (this.views.size > this.limit) {
      const oldest = this.views.keys().next().value;
      if (!oldest) break;
      this.views.delete(oldest);
    }
  }

  forget(id: string): void {
    this.views.delete(id);
  }

  get(id: string): SessionViewSnapshot | undefined {
    return this.views.get(id);
  }
}
