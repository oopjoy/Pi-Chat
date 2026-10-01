const RPC_MODE_SUFFIX = "/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js";

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

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const pathname = new URL(url).pathname.replace(/\\/g, "/");
  if (!pathname.endsWith(RPC_MODE_SUFFIX)) return loaded;
  const source = typeof loaded.source === "string"
    ? loaded.source
    : Buffer.from(loaded.source).toString("utf8");
  return { ...loaded, source: patchPiRpcModeSource(source) };
}
