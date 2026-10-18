import type { PromptImage } from "../../shared/types";
import { composerDraftKeyId, draftFiles, type ComposerDraft, type ComposerDraftKey, type ComposerState } from "../state/composer";

export const DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PREFIX = "pi-chat.draft-backup.v1.";
const DB_NAME = "pi-chat-draft-recovery-v1";
const GENERATION_KEY = "pi-chat.draft-generation.v1";
const MAX_RECORDS = 256;
const CONSUMED_PREFIX = "pi-chat.draft-consumed.v1.";
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const pages = new WeakMap<Document, { owner: string; sequence: number }>();
function pageState() {
  let page = pages.get(document);
  if (!page) { page = { owner: crypto.randomUUID(), sequence: 0 }; pages.set(document, page); }
  return page;
}
export function draftStorageOwner(): string { return pageState().owner; }

type ImageRef = { id: string; name: string };
type Frame = { message: string; files: string[]; images: ImageRef[]; uncertain: boolean };
export type RecoveryRecord = {
  version: 1; id: string; owner: string; key: ComposerDraftKey; generation: string;
  updatedAt: number; sequence: number; frames: Frame[];
};
export type LoadedRecovery = { drafts: ComposerDraft[]; missingImages: string[] };
type ImageSize = { id: string; bytes: number; touchedAt: number };
type PendingRecord = { sequence: number; generation: string; nonempty: boolean; journalSaved: boolean; images: string[] };
type PendingWrite = { record: RecoveryRecord; images: Map<string, PromptImage>; pending: PendingRecord; journalSaved: boolean };

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("本地草稿事务中止"));
    tx.onerror = () => reject(tx.error || new Error("本地草稿保存失败"));
  });
}
function validRecord(value: unknown): value is RecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as RecoveryRecord;
  return r.version === 1 && typeof r.generation === "string" && r.generation.length < 128
    && typeof r.id === "string" && r.id.length < 256
    && typeof r.owner === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(r.owner)
    && Boolean(r.key && (r.key.kind === "session" && typeof r.key.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(r.key.sessionId)
      || r.key.kind === "new" && Number.isSafeInteger(r.key.generation) && r.key.generation >= 0))
    && r.id === `${r.owner}:${composerDraftKeyId(r.key)}`
    && Number.isFinite(r.updatedAt) && Number.isSafeInteger(r.sequence)
    && Array.isArray(r.frames) && r.frames.length <= 128
    && r.frames.every((frame) => frame && typeof frame.uncertain === "boolean" && typeof frame.message === "string" && frame.message.length <= 4 * 1024 * 1024
      && Array.isArray(frame.files) && frame.files.length <= 32 && frame.files.every((path) => typeof path === "string" && path.length <= 32768)
      && Array.isArray(frame.images) && frame.images.length <= 10 && frame.images.every((image) => image && typeof image.id === "string" && image.id.length < 128 && typeof image.name === "string" && image.name.length <= 1024));
}
function hasContent(draft: ComposerDraft): boolean {
  return Boolean(draft.message || draft.images.length || draftFiles(draft).length);
}
function usableImage(value: unknown): value is PromptImage {
  if (!value || typeof value !== "object") return false;
  const image = value as PromptImage;
  return image.type === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)
    && typeof image.data === "string" && image.data.length <= 12 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    && (image.fileName === undefined || typeof image.fileName === "string" && image.fileName.length <= 1024);
}

/** Text journal is synchronous; large image bodies live only in IndexedDB. */
export class DraftRecoveryStore {
  private readonly page = pageState();
  private readonly view = window;
  private readonly journal: Storage | undefined;
  readonly owner = crypto.randomUUID();
  private imageIds = new WeakMap<PromptImage, string>();
  private database?: Promise<IDBDatabase>;
  private tail = Promise.resolve();
  private latestSequence = 0;
  private lastCleanup = 0;
  private verifiedGeneration = "";
  private verifiedImages = new Set<string>();
  private pendingRecords = new Map<string, PendingRecord>();
  private pendingWrites = new Map<string, PendingWrite>();
  private writing = false;
  private lastJournalKeys = new Map<string, string>();
  constructor(private readonly warn: (message: string) => void = () => undefined) {
    try { this.journal = window.localStorage; } catch { /* private/storage-denied mode */ }
  }
  private local(): Storage {
    if (!this.journal) throw new Error("浏览器拒绝草稿存储");
    return this.journal;
  }

  private generation(): string {
    try { return this.local().getItem(GENERATION_KEY) || ""; } catch { return ""; }
  }

  private db(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise((resolve, reject) => {
      if (!this.view.indexedDB) { reject(new Error("浏览器没有可用的 IndexedDB")); return; }
      const opening = this.view.indexedDB.open(DB_NAME, 3);
      opening.onupgradeneeded = () => {
        for (const name of ["records", "images", "sizes", "record-sizes"])
          if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name, { keyPath: "id" });
        const records = opening.transaction!.objectStore("records");
        if (!records.indexNames.contains("session")) records.createIndex("session", "key.sessionId");
        if (!records.indexNames.contains("kind")) records.createIndex("kind", "key.kind");
      };
      let abandoned = false;
      opening.onsuccess = () => {
        if (abandoned) { opening.result.close(); return; }
        opening.result.onversionchange = () => opening.result.close();
        resolve(opening.result);
      };
      opening.onerror = () => { abandoned = true; reject(opening.error); };
      opening.onblocked = () => { abandoned = true; reject(new Error("草稿存储正被其他窗口占用")); };
    });
    return this.database;
  }
  private journalEntries(): Array<{ key: string; record: RecoveryRecord }> {
    const records: Array<{ key: string; record: RecoveryRecord }> = [];
    try {
      for (let i = 0; i < this.local().length; i += 1) {
        const key = this.local().key(i);
        if (!key?.startsWith(PREFIX)) continue;
        try { const record: unknown = JSON.parse(this.local().getItem(key) || "null"); if (validRecord(record)) records.push({ key, record }); }
        catch { /* invalid data never becomes a draft */ }
      }
    } catch { this.warn("浏览器拒绝访问草稿备份，刷新或关闭后可能无法恢复当前输入。"); }
    return records;
  }
  private journals(): RecoveryRecord[] { return this.journalEntries().map((entry) => entry.record); }
  private journalKey(record: RecoveryRecord): string { return `${PREFIX}${record.id}:${record.generation || "initial"}:${record.sequence}`; }
  private frames(partition: ReturnType<typeof import("../state/composer").composerPartition>, images: Map<string, PromptImage>): Frame[] {
    const encode = (draft: ComposerDraft, uncertain = false): Frame => ({
      message: draft.message, files: [...draftFiles(draft)], uncertain: uncertain || draft.recoveryWarning === "delivery-uncertain",
      images: draft.images.map((image) => {
        let id = this.imageIds.get(image);
        if (!id) { id = crypto.randomUUID(); this.imageIds.set(image, id); }
        images.set(id, image);
        return { id, name: image.fileName || "图片" };
      }),
    });
    return [
      ...(hasContent(partition.draft) ? [encode(partition.draft)] : []),
      ...(partition.suspended || []).filter(hasContent).map((draft) => encode(draft)),
      ...(partition.inFlight ? [encode(partition.inFlight, true)] : []),
      ...partition.pending.map((snapshot) => encode(snapshot)),
    ];
  }

  persist(key: ComposerDraftKey, partition: ReturnType<typeof import("../state/composer").composerPartition>, passive = false): void {
    const id = `${this.owner}:${composerDraftKeyId(key)}`;
    const previous = this.pendingRecords.get(id);
    if (passive && previous && previous.generation !== this.generation()) return;
    if (passive && !previous && !hasContent(partition.draft) && !partition.suspended?.some(hasContent)
      && !partition.pending.length && !partition.inFlight) return;
    const images = new Map<string, PromptImage>();
    const record: RecoveryRecord = {
      version: 1, id, owner: this.owner, key, generation: this.generation(),
      updatedAt: Date.now(), sequence: ++this.page.sequence, frames: this.frames(partition, images),
    };
    this.latestSequence = record.sequence;
    const pending = { sequence: record.sequence, generation: record.generation, nonempty: record.frames.length > 0, journalSaved: false, images: [...images.keys()] };
    this.pendingRecords.set(record.id, pending);
    if (!validRecord(record)) { this.warn("草稿超过本地恢复格式的容量限制，未替换已有备份；请先复制保存当前内容。"); return; }
    let journalSaved = false;
    try {
      const records = this.journals().filter((item) => item.frames.length && Date.now() - item.updatedAt < DRAFT_RETENTION_MS);
      if (record.frames.length && records.length >= MAX_RECORDS && !records.some((item) => item.id === record.id))
        throw new Error("草稿备份数量已满，请清理旧备份");
      // An empty tombstone hides an older IDB snapshot until deletion commits;
      // otherwise a close immediately after send acknowledgement resurrects it.
      const key = this.journalKey(record);
      this.local().setItem(key, JSON.stringify(record));
      const previousKey = this.lastJournalKeys.get(record.id);
      this.lastJournalKeys.set(record.id, key);
      if (previousKey && previousKey !== key) this.local().removeItem(previousKey);
      if (record.generation !== this.generation()) this.local().removeItem(key);
      journalSaved = true;
      pending.journalSaved = true;
    } catch { this.warn("草稿快速备份空间不足或不可用；当前输入仍在页面，请勿直接关闭。"); }
    // Coalesce superseded revisions per partition. The synchronous journal
    // already protects the latest text, so slow disk IO cannot build an
    // unbounded chain of whole-state snapshots while the user keeps typing.
    this.pendingWrites.set(record.id, { record, images, pending, journalSaved });
    if (!this.writing) { this.writing = true; this.tail = this.drainWrites(); }
  }

  private async drainWrites(): Promise<void> {
    try {
      while (this.pendingWrites.size) {
        const item = this.pendingWrites.values().next().value!;
        const { record, images, pending, journalSaved } = item;
        this.pendingWrites.delete(record.id);
        try {
          await this.writeDatabase(record, images);
          if (record.generation === this.generation()) {
            this.refreshImageKnowledge();
            for (const id of images.keys()) this.verifiedImages.add(id);
            if (this.pendingRecords.get(record.id)?.sequence === record.sequence) {
              pending.journalSaved = true;
              if (!pending.nonempty) this.pendingRecords.delete(record.id);
            }
          }
          if (record.sequence === this.latestSequence) this.warn("");
        } catch {
          if (record.generation !== this.generation()) continue;
          if (images.size) this.warn("图片草稿未能保存到浏览器；刷新后图片可能无法恢复，文字会尽量从本地日志恢复。");
          else if (!journalSaved) this.warn("草稿备份失败；当前输入仅在本页，请先复制保存。");
        }
      }
    } finally { this.writing = false; }
  }

  private refreshImageKnowledge(): void {
    if (this.verifiedGeneration !== this.generation()) {
      this.verifiedGeneration = this.generation();
      this.verifiedImages.clear();
    }
  }
  needsCloseWarning(): boolean {
    this.refreshImageKnowledge();
    return [...this.pendingRecords.values()].some((record) => record.nonempty
      && (record.generation !== this.generation() || !record.journalSaved
        || record.images.some((id) => !this.verifiedImages.has(id))));
  }

  private async writeDatabase(record: RecoveryRecord, images: Map<string, PromptImage>): Promise<void> {
    const db = await this.db();
    if (record.generation !== this.generation()) return;
    const tx = db.transaction(["records", "images", "sizes", "record-sizes"], "readwrite");
    const done = completed(tx);
    try {
      const records = tx.objectStore("records");
      const keys = await request(records.getAllKeys());
      if (record.frames.length && keys.length >= MAX_RECORDS && !keys.includes(record.id)) throw new Error("草稿备份数量超限");
      const recordSizes = await request(tx.objectStore("record-sizes").getAll()) as Array<{ id: string; bytes: number }>;
      if (recordSizes.some((size) => !Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.bytes > MAX_RECORD_BYTES)) throw new Error("草稿容量记录无效");
      const bytes = record.frames.length ? JSON.stringify(record).length * 2 : 0;
      const totalRecords = recordSizes.reduce((sum, size) => sum + (size.id === record.id ? 0 : size.bytes), bytes);
      if (record.frames.length && totalRecords > MAX_RECORD_BYTES) throw new Error("文字草稿备份空间已满");
      if (record.frames.length) tx.objectStore("record-sizes").put({ id: record.id, bytes });
      else tx.objectStore("record-sizes").delete(record.id);
      const sizes = new Map((await request(tx.objectStore("sizes").getAll()) as ImageSize[]).map((size) => [size.id, size]));
      if ([...sizes.values()].some((size) => !Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.bytes > MAX_IMAGE_BYTES)) throw new Error("图片容量记录无效");
      let total = [...sizes.values()].reduce((sum, size) => sum + size.bytes, 0);
      for (const [id, image] of images) {
        if (!sizes.has(id)) {
          total += image.data.length * 2;
          if (total > MAX_IMAGE_BYTES || sizes.size >= 512) throw new Error("图片草稿备份已满");
          tx.objectStore("images").put({ id, image });
        }
        const size = { id, bytes: image.data.length * 2, touchedAt: Date.now() };
        sizes.set(id, size);
        tx.objectStore("sizes").put(size);
      }
      if (record.generation !== this.generation()) throw new Error("草稿备份已被用户清除");
      if (record.frames.length) records.put(record);
      else records.delete(record.id);
      await done;
      // Once the full record/image transaction is durable, retire only this
      // exact journal revision. A newer keystroke or tombstone must survive.
      try {
        for (const entry of this.journalEntries())
          if (entry.record.id === record.id && entry.record.sequence <= record.sequence && entry.record.generation === record.generation)
            this.local().removeItem(entry.key);
      } catch { /* keeping a verified duplicate is safer than losing the journal */ }
    } catch (error) { try { tx.abort(); } catch { /* completed */ } await done.catch(() => undefined); throw error; }
  }

  async records(key?: ComposerDraftKey): Promise<RecoveryRecord[]> {
    const merged = new Map<string, RecoveryRecord>();
    try {
      const db = await this.db();
      const tx = db.transaction("records", "readonly");
      const records = tx.objectStore("records");
      const query = key ? key.kind === "session"
        ? records.index("session").getAll(key.sessionId) : records.index("kind").getAll("new") : records.getAll();
      for (const value of await request(query)) if (validRecord(value)) merged.set(value.id, value);
    } catch { /* the synchronous journal remains independently usable */ }
    for (const record of this.journals()) {
      const previous = merged.get(record.id);
      if (!previous || record.sequence >= previous.sequence) merged.set(record.id, record);
    }
    return [...merged.values()].filter((record) => record.generation === this.generation()
      && Date.now() - record.updatedAt < DRAFT_RETENTION_MS && record.frames.length > 0
      && (!key || (key.kind === "new" ? record.key.kind === "new" : record.key.kind === "session" && record.key.sessionId === key.sessionId)))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS);
  }

  async discover(key: ComposerDraftKey): Promise<RecoveryRecord[]> {
    return (await this.records(key)).filter((record) => {
      if (key.kind === "new" ? record.key.kind !== "new" : record.key.kind !== "session" || record.key.sessionId !== key.sessionId) return false;
      try {
        const consumed = JSON.parse(this.local().getItem(CONSUMED_PREFIX + record.id) || "null") as { sequence?: number } | null;
        if (typeof consumed?.sequence === "number" && consumed.sequence >= record.sequence) return false;
      } catch { /* no receipt grants send authority */ }
      return true;
    });
  }

  consume(record: RecoveryRecord): void {
    // A receipt hides this exact revision without deleting another live window's
    // backup. If that window edits again, its higher sequence is discoverable.
    try { this.local().setItem(CONSUMED_PREFIX + record.id, JSON.stringify({ sequence: record.sequence, at: Date.now() })); }
    catch { this.warn("无法记住这次恢复操作，下次打开可能再次显示这份备份。"); }
  }

  async isCurrent(record: RecoveryRecord): Promise<boolean> {
    if (!validRecord(record) || record.generation !== this.generation()) return false;
    let current: RecoveryRecord | undefined;
    try {
      const db = await this.db();
      const value: unknown = await request(db.transaction("records", "readonly").objectStore("records").get(record.id));
      if (validRecord(value)) current = value;
    } catch { /* the latest uncommitted journal can still be authoritative */ }
    try {
      for (const { record: value } of this.journalEntries())
        if (value.id === record.id && (!current || value.sequence >= current.sequence)) current = value;
    } catch { /* no text journal */ }
    return Boolean(current && current.frames.length && current.sequence === record.sequence
      && current.generation === this.generation() && Date.now() - current.updatedAt < DRAFT_RETENTION_MS);
  }

  async load(record: RecoveryRecord): Promise<LoadedRecovery> {
    if (!validRecord(record) || record.generation !== this.generation() || Date.now() - record.updatedAt >= DRAFT_RETENTION_MS
      || !await this.isCurrent(record)) throw new Error("草稿备份已更新、已发送或已失效，请重新读取");
    const missingImages: string[] = [];
    const loaded = new Map<string, PromptImage>();
    try {
      const db = await this.db();
      const tx = db.transaction(["images", "sizes"], "readwrite");
      const done = completed(tx);
      try {
        const references = record.frames.flatMap((frame) => frame.images);
        const values = await Promise.all(references.map((ref) => request(tx.objectStore("images").get(ref.id))));
        references.forEach((ref, index) => {
          const image = (values[index] as { image?: unknown } | undefined)?.image;
          if (!usableImage(image)) return;
          loaded.set(ref.id, image);
          this.imageIds.set(image, ref.id);
          tx.objectStore("sizes").put({ id: ref.id, bytes: image.data.length * 2, touchedAt: Date.now() });
        });
        await done;
        if (record.generation === this.generation()) {
          this.refreshImageKnowledge();
          for (const id of loaded.keys()) this.verifiedImages.add(id);
        }
      } catch (error) { try { tx.abort(); } catch { /* completed */ } await done.catch(() => undefined); throw error; }
    } catch { /* missing image bodies are explicitly named below */ }
    return {
      drafts: record.frames.map((frame) => ({
        message: frame.message, files: [...frame.files], revision: 0,
        ...(frame.uncertain ? { recoveryWarning: "delivery-uncertain" as const } : {}),
        images: frame.images.flatMap((ref) => {
          const image = loaded.get(ref.id);
          if (!image) { missingImages.push(ref.name); return []; }
          return [image];
        }),
      })).filter(hasContent),
      missingImages,
    };
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    if (this.lastCleanup && now - this.lastCleanup < 6 * 60 * 60 * 1000) return;
    this.lastCleanup = now;
    for (const entry of this.journalEntries()) {
      if (entry.record.generation !== this.generation() || now - entry.record.updatedAt >= DRAFT_RETENTION_MS)
        this.local().removeItem(entry.key);
    }
    try {
      const db = await this.db();
      const tx = db.transaction(["records", "images", "sizes", "record-sizes"], "readwrite");
      const done = completed(tx);
      try {
        const journals = new Map<string, RecoveryRecord>();
        const references = new Set<string>();
        for (const record of this.journals()) {
          const previous = journals.get(record.id);
          if (!previous || record.sequence >= previous.sequence) journals.set(record.id, record);
          for (const frame of record.frames) for (const image of frame.images) references.add(image.id);
        }
        const databaseRecords = await request(tx.objectStore("records").getAll());
        const retained = new Map(journals);
        for (const record of databaseRecords) {
          if (!validRecord(record)) continue;
          const journal = journals.get(record.id);
          const effective = journal && journal.sequence >= record.sequence ? journal : record;
          if (effective.generation !== this.generation() || now - effective.updatedAt >= DRAFT_RETENTION_MS) {
            tx.objectStore("records").delete(record.id);
            tx.objectStore("record-sizes").delete(record.id);
          } else retained.set(record.id, effective);
        }
        for (const record of retained.values())
          for (const frame of record.frames) for (const image of frame.images) references.add(image.id);
        for (const size of await request(tx.objectStore("sizes").getAll()) as ImageSize[]) {
          if (!references.has(size.id) && now - size.touchedAt > 24 * 60 * 60 * 1000) {
            tx.objectStore("images").delete(size.id);
            tx.objectStore("sizes").delete(size.id);
          }
        }
        await done;
      } catch (error) { try { tx.abort(); } catch { /* completed */ } await done.catch(() => undefined); throw error; }
    } catch { /* text-only journal recovery still works without IDB */ }
  }

  async clear(): Promise<void> {
    // Retire old writers, but do not erase deliberate edits made after this
    // generation change in another active window.
    this.local().setItem(GENERATION_KEY, crypto.randomUUID());
    const keys: string[] = [];
    for (let i = 0; i < this.local().length; i += 1) {
      const key = this.local().key(i);
      if (key?.startsWith(PREFIX) || key?.startsWith(CONSUMED_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const value: unknown = JSON.parse(this.local().getItem(key) || "null");
        if (!validRecord(value) || value.generation !== this.generation()) this.local().removeItem(key);
      } catch { this.local().removeItem(key); }
    }
    try {
      const db = await this.db();
      const tx = db.transaction(["records", "images", "sizes", "record-sizes"], "readwrite");
      const done = completed(tx);
      try {
        const references = new Set<string>();
        for (const record of await request(tx.objectStore("records").getAll())) {
          if (!validRecord(record) || record.generation !== this.generation()) {
            tx.objectStore("records").delete((record as RecoveryRecord).id);
            tx.objectStore("record-sizes").delete((record as RecoveryRecord).id);
          } else for (const frame of record.frames) for (const image of frame.images) references.add(image.id);
        }
        for (const record of this.journals())
          if (record.generation === this.generation())
            for (const frame of record.frames) for (const image of frame.images) references.add(image.id);
        for (const id of await request(tx.objectStore("images").getAllKeys()))
          if (!references.has(String(id))) tx.objectStore("images").delete(id);
        for (const id of await request(tx.objectStore("sizes").getAllKeys()))
          if (!references.has(String(id))) tx.objectStore("sizes").delete(id);
        await done;
      } catch (error) { try { tx.abort(); } catch { /* completed */ } await done.catch(() => undefined); throw error; }
    } catch { throw new Error("本地数据库未能清理，部分文字或图片备份可能仍在；请在浏览器站点数据设置中重试。"); }
  }

  async flush(): Promise<void> { await this.tail; }
}

export function composerFileReferences(state: ComposerState): string[] {
  const paths = new Set<string>();
  for (const partition of Object.values(state.partitions)) {
    if (!partition) continue;
    for (const draft of [partition.draft, ...(partition.suspended || []), ...partition.pending,
      ...(partition.inFlight ? [partition.inFlight] : [])])
      for (const path of draftFiles(draft)) paths.add(path);
  }
  return [...paths];
}
