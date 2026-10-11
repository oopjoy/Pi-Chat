import { createTurnSettingsAction, type TurnSettingsPorts, type TurnSettingsRpc, type TurnSettingsSnapshot } from "../../src/server/services/turn-settings-action";
import type { PiRpcClient } from "../../src/server/rpc-client";

declare const ports: TurnSettingsPorts;
declare const rpc: TurnSettingsRpc;
declare const realRpc: PiRpcClient;
declare const settings: TurnSettingsSnapshot;
const apply = createTurnSettingsAction(ports);
const _compatible: TurnSettingsRpc = realRpc;
void apply(rpc, settings, "session");
void rpc.send({ type: "get_available_models" });
void rpc.send({ type: "set_model", provider: "test", modelId: "model" });

// @ts-expect-error The settings transaction cannot dispatch a Prompt.
void rpc.send({ type: "prompt", message: "not settings" });
// @ts-expect-error The settings transaction cannot switch Session files.
void rpc.send({ type: "switch_session", sessionPath: "another.jsonl" });
// @ts-expect-error No process stop authority crosses the boundary.
rpc.stop();
// @ts-expect-error No process restart authority crosses the boundary.
rpc.restart();
// @ts-expect-error The send capability cannot be replaced.
rpc.send = async () => ({});
// @ts-expect-error Native set_model has no api selector.
void rpc.send({ type: "set_model", provider: "test", modelId: "model", api: "unsupported selector" });
// @ts-expect-error Only supported Thinking levels can be sent.
void rpc.send({ type: "set_thinking_level", level: "arbitrary" });
declare const setOnly: (command: { type: "set_model"; provider: string; modelId: string }) => Promise<Record<string, unknown>>;
// @ts-expect-error All four allowed commands must be supported, not only writes.
const _incompleteRpc: TurnSettingsRpc = { send: setOnly };
const { markRpcOutcomePending: _mark, ...missingFailurePolicy } = ports;
// @ts-expect-error The mutating-failure policy is mandatory.
createTurnSettingsAction(missingFailurePolicy);
// @ts-expect-error A synchronous state effect cannot secretly become async.
const _asyncFailurePolicy: TurnSettingsPorts["markRpcOutcomePending"] = async () => {};
// @ts-expect-error The late-response factory must synchronously return a handler.
const _asyncHandlerFactory: TurnSettingsPorts["lateRpcOutcomeHandler"] = async () => () => {};
// @ts-expect-error No broad App options are exposed.
ports.options.rpc;
// @ts-expect-error The applied input is an immutable snapshot.
settings.thinkingLevel = "low";
if (settings.model) {
  // @ts-expect-error The captured route cannot be rebound by the transaction.
  settings.model.provider = "other";
}
