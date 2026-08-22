import { readFile } from "node:fs/promises";
import type { SessionForkOrigin } from "../shared/types.js";
import { writeFileAtomic } from "./file-transaction.js";

const SESSION_ID = /^[a-f0-9]{20}$/;
const MAX_RELATIONS = 10_000;
const MAX_SOURCE_NAME = 120;
const MAX_PERSISTED_MESSAGE_ID = 500;

export type StoredSessionForkOrigin = Omit<SessionForkOrigin, "sourceAvailable">;

interface SessionRelationsFile {
  version: 1;
  forks: Record<string, StoredSessionForkOrigin>;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\0-\x1f\x7f]/.test(value);
}

function validForkOrigin(value: unknown, destinationSessionId: string): value is StoredSessionForkOrigin {
  if (!SESSION_ID.test(destinationSessionId) || !value || typeof value !== "object") return false;
  const relation = value as Partial<StoredSessionForkOrigin>;
  return typeof relation.sourceSessionId === "string"
    && SESSION_ID.test(relation.sourceSessionId)
    && relation.sourceSessionId !== destinationSessionId
    && validText(relation.sourceName, MAX_SOURCE_NAME)
    && validText(relation.sourcePersistedMessageId, MAX_PERSISTED_MESSAGE_ID)
    && typeof relation.createdAt === "number"
    && Number.isFinite(relation.createdAt)
    && relation.createdAt >= 0;
}

async function defaultReadText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

type SessionRelationStoreOptions = {
  readText?: (path: string) => Promise<string>;
  writeAtomic?: (path: string, content: string) => Promise<void>;
};

async function loadRelations(path: string, readText: (path: string) => Promise<string>): Promise<Map<string, StoredSessionForkOrigin>> {
  let content: string;
  try { content = await readText(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const parsed = JSON.parse(content) as Partial<SessionRelationsFile>;
  if (parsed.version !== 1 || !parsed.forks || typeof parsed.forks !== "object")
    throw new Error("Session 来源关系文件格式无效");
  const entries = Object.entries(parsed.forks);
  if (entries.some((entry) => !validForkOrigin(entry[1], entry[0])))
    throw new Error("Session 来源关系文件包含无效记录");
  return new Map((entries as Array<[string, StoredSessionForkOrigin]>)
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .slice(-MAX_RELATIONS));
}

export class SessionRelationStore {
  private cache: Map<string, StoredSessionForkOrigin> | null = null;
  private loadPromise: Promise<Map<string, StoredSessionForkOrigin>> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  private readonly readText: (path: string) => Promise<string>;
  private readonly writeAtomic: (path: string, content: string) => Promise<void>;

  constructor(readonly path: string, options: SessionRelationStoreOptions = {}) {
    this.readText = options.readText || defaultReadText;
    this.writeAtomic = options.writeAtomic || writeFileAtomic;
  }

  private async relations(): Promise<Map<string, StoredSessionForkOrigin>> {
    if (this.cache) return this.cache;
    this.loadPromise ||= loadRelations(this.path, this.readText);
    try {
      this.cache = await this.loadPromise;
      return this.cache;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  private async save(relations: Map<string, StoredSessionForkOrigin>): Promise<void> {
    const data: SessionRelationsFile = { version: 1, forks: Object.fromEntries(relations) };
    await this.writeAtomic(this.path, `${JSON.stringify(data)}\n`);
  }

  async getForkOrigin(destinationSessionId: string): Promise<StoredSessionForkOrigin | null> {
    if (!SESSION_ID.test(destinationSessionId)) return null;
    const relation = (await this.relations()).get(destinationSessionId);
    return relation ? { ...relation } : null;
  }

  async recordFork(destinationSessionId: string, relation: StoredSessionForkOrigin): Promise<void> {
    if (!validForkOrigin(relation, destinationSessionId)) throw new Error("Session Fork 来源关系无效");
    const run = this.mutationTail.then(async () => {
      const next = new Map(await this.relations());
      next.delete(destinationSessionId);
      next.set(destinationSessionId, { ...relation });
      while (next.size > MAX_RELATIONS) {
        const oldest = next.keys().next().value;
        if (typeof oldest !== "string") break;
        next.delete(oldest);
      }
      await this.save(next);
      this.cache = next;
    });
    this.mutationTail = run.catch(() => undefined);
    await run;
  }

  async removeDestination(destinationSessionId: string): Promise<void> {
    if (!SESSION_ID.test(destinationSessionId)) return;
    const run = this.mutationTail.then(async () => {
      const current = await this.relations();
      if (!current.has(destinationSessionId)) return;
      const next = new Map(current);
      next.delete(destinationSessionId);
      await this.save(next);
      this.cache = next;
    });
    this.mutationTail = run.catch(() => undefined);
    await run;
  }
}
