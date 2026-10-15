import { createHash as __piChatCreateHash } from "node:crypto";

const RPC_MODE_SUFFIX = "/dist/modes/rpc/rpc-mode.js";
const AGENT_SESSION_SUFFIX = "/dist/core/agent-session.js";
const EXTENSION_LOADER_SUFFIX = "/dist/core/extensions/loader.js";
const MAIN_SUFFIX = "/dist/main.js";

const FOLLOW_UP_CASES = [
  `            case "follow_up": {
                await session.followUp(command.message, command.images);
                return success(id, "follow_up");
            }
            case "abort": {`,
  `            case "follow_up": {
                await session.followUp(command.message, command.images, { source: "rpc" });
                return success(id, "follow_up");
            }
            case "abort": {`,
];

const DEQUEUE_CASE = `            case "dequeue": {
                const queues = session.clearQueue();
                output({
                    type: "pi_chat_queue_dequeued",
                    dequeueId: command.dequeueId,
                    steering: queues.steering,
                    followUp: queues.followUp,
                });
                return success(id, "dequeue", queues);
            }
            case "abort": {`;

export function patchPiRpcModeSource(source) {
  if (source.includes('type: "pi_chat_queue_dequeued"')) return source;
  const matches = FOLLOW_UP_CASES.filter((candidate) => source.includes(candidate));
  if (matches.length === 1)
    return source.replace(
      matches[0],
      matches[0].replace('            case "abort": {', DEQUEUE_CASE),
    );

  // Pi 0.85+ adds a disposition result to followUp(). Keep the adapter
  // process-local while accepting that source evolution; do not patch or
  // rewrite the globally installed Pi file.
  const structural = /(^[ \t]*case "follow_up": \{[\s\S]*?)(^[ \t]*case "abort": \{)/m.exec(source);
  if (structural)
    return source.replace(structural[0], `${structural[1]}${DEQUEUE_CASE}`);

  throw new Error(
    "当前 Pi RPC 实现与 Steer 撤回适配器不兼容；未修改全局 Pi，请更新 Pi Chat 适配器",
  );
}

export function patchPiExtensionLoaderSource(source) {
  if (source.includes("__piChatStartupExtensionOrdinal")) return source;
  const importMarker = "const module = await jiti.import(extensionPath, { default: true });";
  const factoryMarker = "await factory(load.api);";
  if (!source.includes(importMarker) || !source.includes(factoryMarker)) return source;
  return source
    .replace(
      importMarker,
      "const extensionOrdinal = (globalThis.__piChatStartupExtensionOrdinal = (globalThis.__piChatStartupExtensionOrdinal || 0) + 1);\n    globalThis.__piChatStartupMark?.(\"X\", extensionOrdinal);\n    const module = await jiti.import(extensionPath, { default: true });\n    globalThis.__piChatStartupMark?.(\"Y\", extensionOrdinal);",
    )
    .replace(
      factoryMarker,
      "globalThis.__piChatStartupMark?.(\"F\", globalThis.__piChatStartupExtensionOrdinal);\n        await factory(load.api);\n        globalThis.__piChatStartupMark?.(\"G\", globalThis.__piChatStartupExtensionOrdinal);",
    );
}

/** Diagnostic-only milestones: no source match means no patch, never a startup failure. */
export function patchPiStartupMilestones(source) {
  if (source.includes("/* pi-chat-startup-milestones */")) return source;
  const anchors = [
    ['time("parseArgs");', "A"],
    ['time("createRuntime");', "R"],
    ['time("createAgentSessionRuntime");', "S"],
  ];
  if (anchors.some(([anchor]) => source.split(anchor).length !== 2)) return source;
  let patched = source;
  for (const [anchor, marker] of anchors)
    patched = patched.replace(anchor, `${anchor}\n    try { globalThis.__piChatStartupMark?.("${marker}"); } catch { /* diagnostics are fail-open */ }`);
  return `/* pi-chat-startup-milestones */\n${patched}`;
}

/** Fixed wire contract shared with the Host's promptPayloadFingerprint. */
export function piChatPromptReceipt(message) {
  if (!message || message.role !== "user" || !Number.isFinite(message.timestamp)) return undefined;
  const content = typeof message.content === "string" ? [["text", message.content]]
    : Array.isArray(message.content) ? message.content.map(block => block.type === "image"
      ? ["image", block.data || "", block.mimeType || ""]
      : [block.type, block.text || ""]) : [];
  return {
    version: 1,
    timestamp: message.timestamp,
    payloadFingerprint: __piChatCreateHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}

/** Only add metadata to native preflight; never change messages or persistence. */
export function patchPiPromptReceiptSource(source) {
  if (source.includes("__piChatPromptReceipt")) return source;
  const marker = 'preflightResult?.("started");';
  const deferred = '() => preflightResult?.("started")';
  const prepared = 'onStarted?.();';
  let patched;
  if (source.split(marker).length === 2 && source.includes('await this._runAgentPrompt(messages);')) {
    patched = source.replace(marker, 'preflightResult?.("started", __piChatPromptReceipt(messages.find(message => message.role === "user")));');
  } else if (source.split(deferred).length === 2 && source.split(prepared).length === 2
    && source.includes('messages = await this._prepareRun(trigger);')) {
    // Pi 1.2 prepares the same canonical user message inside _startRun.
    patched = source.replace(deferred, '(piChatUserMessage) => preflightResult?.("started", piChatUserMessage)')
      .replace(prepared, 'onStarted?.(__piChatPromptReceipt(messages.find(message => message.role === "user")));');
  } else return source;
  return 'import { createHash as __piChatCreateHash } from "node:crypto";\n'
    + `const __piChatPromptReceipt = ${piChatPromptReceipt.toString()};\n`
    + patched;
}

export function patchPiPromptResponseSource(source) {
  if (source.includes("piChatUserMessage")) return source;
  const callback = "preflightResult: (disposition) => {";
  const response = 'output(success(id, "prompt", { disposition }));';
  if (source.split(callback).length !== 2 || source.split(response).length !== 2) return source;
  return source.replace(callback, "preflightResult: (disposition, piChatUserMessage) => {")
    .replace(response, 'output(success(id, "prompt", { disposition, ...(piChatUserMessage ? { piChatUserMessage } : {}) }));');
}

function patchLoadedSource(url, loaded) {
  const pathname = new URL(url).pathname.replace(/\\/g, "/");
  const shouldPatchRpc = pathname.endsWith(RPC_MODE_SUFFIX);
  const shouldPatchExtensions = pathname.endsWith(EXTENSION_LOADER_SUFFIX);
  const shouldPatchPrompt = pathname.endsWith(AGENT_SESSION_SUFFIX);
  const shouldPatchMain = pathname.endsWith(MAIN_SUFFIX);
  if (!shouldPatchRpc && !shouldPatchExtensions && !shouldPatchPrompt && !shouldPatchMain) return loaded;
  if (loaded.source === null || loaded.source === undefined) return loaded;
  const source = typeof loaded.source === "string"
    ? loaded.source
    : Buffer.from(loaded.source).toString("utf8");
  if (shouldPatchMain)
    return { ...loaded, source: patchPiStartupMilestones(source) };
  if (shouldPatchRpc)
    return { ...loaded, source: patchPiPromptResponseSource(patchPiRpcModeSource(source)) };
  if (shouldPatchPrompt)
    return { ...loaded, source: patchPiPromptReceiptSource(source) };
  return { ...loaded, source: patchPiExtensionLoaderSource(source) };
}

// Node 22.15+ can keep this selective adapter on the importing thread. Using
// the async loader for every dependency adds cross-thread traffic even when
// none of that dependency's source needs patching.
export function loadSync(url, context, nextLoad) {
  return patchLoadedSource(url, nextLoad(url, context));
}

export async function load(url, context, nextLoad) {
  return patchLoadedSource(url, await nextLoad(url, context));
}
