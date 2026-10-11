// Compile-only checks for the service AND the capabilities its caller supplies.
import { createSessionCopyOriginActions, type SessionCopyOriginInput, type SessionCopyOriginPorts } from "../../src/server/services/session-copy-origin-actions";

declare const ports: SessionCopyOriginPorts;
declare const input: SessionCopyOriginInput;
createSessionCopyOriginActions(ports);
const { recoverSource: _recover, ...withoutRecovery } = ports;
// @ts-expect-error Recovery is required, not an optional callback hidden in a host bag.
createSessionCopyOriginActions(withoutRecovery);
// @ts-expect-error Global App options are not a service capability.
ports.options.rpc;
// @ts-expect-error The service cannot mutate the App's backing Set.
ports.copyingSessionIds.clear();
// @ts-expect-error A Session id cannot be replaced by an arbitrary number.
ports.setCopying(1, true);
// @ts-expect-error An async effect cannot silently implement a synchronous state marker.
const _asyncMarker: SessionCopyOriginPorts["setCopying"] = async () => {};
// @ts-expect-error RPC completion must include the required result/uncertainty fields.
const _invalidCopy: SessionCopyOriginPorts["executeCopy"] = async () => ({});
// @ts-expect-error The transaction's source identity is immutable input.
input.id = "replacement";
if (input.runtime) {
  // @ts-expect-error Only an identity handle crosses the boundary, never its RPC.
  input.runtime.rpc.stop();
  // @ts-expect-error The service cannot rebind an admitted Runtime handle.
  input.runtime.id = "another";
}
// @ts-expect-error The caller's known-id snapshot cannot be mutated by the service.
input.knownSessionIds.add("new-id");
declare const origin: Awaited<ReturnType<SessionCopyOriginPorts["readOrigin"]>>;
if (origin) {
  // @ts-expect-error Provenance is a read-only projection, not its backing store.
  origin.sourceName = "overwritten";
}
