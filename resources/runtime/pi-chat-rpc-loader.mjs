const RPC_MODE_SUFFIX = "/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js";

const FOLLOW_UP_CASE = `            case "follow_up": {
                await session.followUp(command.message, command.images);
                return success(id, "follow_up");
            }
            case "abort": {`;

const DEQUEUE_CASE = `            case "follow_up": {
                await session.followUp(command.message, command.images);
                return success(id, "follow_up");
            }
            case "dequeue": {
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
  if (!source.includes(FOLLOW_UP_CASE)) {
    throw new Error(
      "当前 Pi RPC 实现与 Steer 撤回适配器不兼容；未修改全局 Pi，请更新 Pi Chat 适配器",
    );
  }
  return source.replace(FOLLOW_UP_CASE, DEQUEUE_CASE);
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
