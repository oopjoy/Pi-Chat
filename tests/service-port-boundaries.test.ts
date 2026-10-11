import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function forbidden(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (value: ts.Node) => {
    if (value.kind === ts.SyntaxKind.AnyKeyword) found.push("any");
    if (ts.isIdentifier(value) && value.text === "Reflect") found.push("reflective-access");
    if (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value)) found.push("type-assertion");
    if (ts.isNewExpression(value) && value.expression.getText() === "Proxy") found.push("whole-object-proxy");
    ts.forEachChild(value, visit);
  };
  visit(node);
  return found;
}

async function assertServiceBoundary(module: string, methodName: string, factoryName: string, forwarderName: string) {
  const serviceText = await readFile(new URL(`../src/server/services/${module}.ts`, import.meta.url), "utf8");
  const appText = await readFile(new URL("../src/server/app.ts", import.meta.url), "utf8");
  const service = ts.createSourceFile("service.ts", serviceText, ts.ScriptTarget.Latest, true);
  const app = ts.createSourceFile("app.ts", appText, ts.ScriptTarget.Latest, true);
  let method: ts.MethodDeclaration | undefined;
  let forwarder: ts.MethodDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node)) {
      if (node.name.getText(app) === methodName) method = node;
      if (node.name.getText(app) === forwarderName) forwarder = node;
    }
    ts.forEachChild(node, find);
  };
  find(app);
  assert.ok(method);
  assert.ok(forwarder);
  assert.deepEqual(forbidden(service), []);
  assert.deepEqual(forbidden(method), []);
  assert.deepEqual(forbidden(forwarder), []);
  const calls: ts.CallExpression[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(app) === factoryName) calls.push(node);
    ts.forEachChild(node, inspect);
  };
  inspect(method);
  assert.equal(calls.length, 1);
  assert.ok(ts.isObjectLiteralExpression(calls[0].arguments[0]), "the actual caller must supply explicit capabilities, not the App or an opaque host bag");
  assert.equal(calls[0].arguments[0].properties.some(ts.isSpreadAssignment), false, "do not hide a whole host inside an object spread");
}

test("the copy-origin service and its actual App wiring cannot regress to Proxy or type escapes", async () => {
  await assertServiceBoundary("session-copy-origin-actions", "sessionCopyOriginActions", "createSessionCopyOriginActions", "runBoundSessionCopy");
});

test("turn settings and its actual App wiring cannot regress to Proxy or type escapes", async () => {
  await assertServiceBoundary("turn-settings-action", "turnSettingsAction", "createTurnSettingsAction", "applyTurnSettings");
});

test("copy boundary guard detects Proxy, any and double assertion escape fixtures", () => {
  for (const code of ["new Proxy(this, {});", "const x: any = value;", "const host = value as unknown as Ports;", "const r = Reflect; r.get(this, 'rpc');"])
    assert.ok(forbidden(ts.createSourceFile("negative.ts", code, ts.ScriptTarget.Latest, true)).length > 0);
});
