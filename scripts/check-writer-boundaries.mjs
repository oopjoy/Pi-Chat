import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import ts from "typescript";

const cacheMutations = new Set(["remember", "mergeNavigation", "refresh", "patch", "updateLive", "appendTerminal", "forget", "clear", "setPinned"]);
const runtimeSetters = new Set(["setPrimaryRuntime", "setPrimaryCapabilitySnapshot", "setApplicationLifecycle", "publishPrimaryReadiness", "publishPrimaryCapabilitySnapshot", "publishApplicationLifecycle"]);
const cacheOwners = new Set(["src/web/lib/session-view-cache.ts", "src/web/application/session-view-cache-writer.ts"]);
const normalize = path => path.replaceAll("\\", "/");

/** AST/symbol guard for known writer bypasses, not a replacement for behavior or type tests. */
export function writerBoundaryViolations(files) {
  const byPath = new Map(files.map(file => [normalize(resolve(file.path)), file]));
  const sourceFiles = new Map([...byPath].map(([path, file]) => [path, ts.createSourceFile(path, file.source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]));
  const options = { noEmit: true, noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = path => sourceFiles.get(normalize(resolve(path)));
  host.fileExists = path => sourceFiles.has(normalize(resolve(path)));
  host.readFile = path => byPath.get(normalize(resolve(path)))?.source;
  const program = ts.createProgram([...sourceFiles.keys()], options, host);
  const checker = program.getTypeChecker();
  const tags = new Map();
  const priority = { "cache-ref": 1, cache: 2, "active-setter": 3, "runtime-setter": 4, "legacy-cache-write": 5, "cache-write": 6 };
  const name = node => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
  const member = node => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (!ts.isElementAccessExpression(node)) return undefined;
    if (ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
    const keyType = checker.getTypeAtLocation(node.argumentExpression);
    return keyType.isStringLiteral() ? keyType.value : undefined;
  };
  const special = key => key === "viewCacheRef" ? "cache-ref" : key === "setActiveSessionIds" ? "active-setter" : runtimeSetters.has(key) ? "runtime-setter" : key === "rememberSessionView" ? "legacy-cache-write" : undefined;
  const unwrap = node => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
    return node;
  };
  const tag = input => {
    if (!input) return undefined;
    const node = unwrap(input);
    if (ts.isIdentifier(node)) {
      const known = tags.get(checker.getSymbolAtLocation(node)) || special(node.text);
      if (known) return known;
    }
    const key = member(node);
    if (key) {
      const known = special(key);
      if (known) return known;
      const receiver = tag(node.expression);
      if (receiver === "cache-ref" && key === "current") return "cache";
      if (receiver === "cache" && cacheMutations.has(key)) return "cache-write";
      if (["call", "apply", "bind"].includes(key)) return receiver;
    }
    if (ts.isCallExpression(node) && member(node.expression) === "bind") return tag(node.expression.expression);
    // Also catch typed aliases and new SessionViewCache instances, not just the
    // historical viewCacheRef spelling. Symbols distinguish shadowed locals.
    if (checker.getTypeAtLocation(node).getSymbol()?.getName() === "SessionViewCache") return "cache";
    return undefined;
  };
  const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
  const bind = (node, value) => {
    if (!value || !ts.isIdentifier(node)) return false;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || (priority[tags.get(symbol)] || 0) >= priority[value]) return false;
    tags.set(symbol, value);
    return true;
  };
  // Propagate simple assignment, reference and destructuring aliases to a fixed
  // point. No executing source or reading files outside the supplied inventory.
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of sourceFiles.values()) walk(source, node => {
      if (ts.isVariableDeclaration(node) && node.initializer) changed = bind(node.name, tag(node.initializer)) || changed;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) changed = bind(node.left, tag(node.right)) || changed;
      if (ts.isBindingElement(node)) {
        const key = name(node.propertyName || node.name);
        let value = special(key);
        const declaration = node.parent.parent;
        if (!value && ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const receiver = tag(declaration.initializer);
          if (receiver === "cache-ref" && key === "current") value = "cache";
          if (receiver === "cache" && cacheMutations.has(key)) value = "cache-write";
        }
        changed = bind(node.name, value) || changed;
      }
    });
  }
  const inConstructor = (node, constructor) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === constructor) return true;
    return false;
  };
  const violations = [];
  for (const [path, source] of sourceFiles) {
    const file = normalize(byPath.get(path).path);
    walk(source, node => {
      if (!ts.isCallExpression(node)) return;
      const kind = tag(node.expression);
      if (!kind || kind === "cache" || kind === "cache-ref") return;
      if (kind === "cache-write" && cacheOwners.has(file)) return;
      if (kind === "runtime-setter" && file === "src/web/App.tsx" && inConstructor(node, "RuntimeProjectionWriter")) return;
      if (kind === "active-setter" && file === "src/web/application/session-projection-state.tsx" && inConstructor(node, "ActiveSessionProjectionWriter")) return;
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push({ file, line: position.line + 1, kind, expression: node.expression.getText(source) });
    });
  }
  return violations;
}

export async function collectWriterBoundarySources(root = resolve(import.meta.dirname, "..")) {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.tsx?$/.test(entry.name)) files.push({ path: normalize(relative(root, path)), source: await readFile(path, "utf8") });
    }
  };
  await visit(resolve(root, "src/web"));
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const files = await collectWriterBoundarySources();
  const violations = writerBoundaryViolations(files);
  if (violations.length) { console.error(JSON.stringify(violations, null, 2)); process.exitCode = 1; }
  else console.log(`[Pi Chat] Writer boundaries checked in ${files.length} Web source files.`);
}
