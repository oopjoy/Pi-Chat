import { readFileSync } from "node:fs";
import ts from "typescript";

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return null;
}

function literalArrayValues(node) {
  const expression = ts.isAsExpression(node) ? node.expression : node;
  if (!ts.isArrayLiteralExpression(expression)) return null;
  const values = expression.elements.map(literalValue);
  return values.every((value) => value !== null) ? values : null;
}

function loopBindings(node) {
  const bindings = new Map();
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isForOfStatement(current)) continue;
    const declaration = ts.isVariableDeclarationList(current.initializer)
      ? current.initializer.declarations[0]
      : null;
    if (!declaration || !ts.isIdentifier(declaration.name)) continue;
    const values = literalArrayValues(current.expression);
    if (values) bindings.set(declaration.name.text, values);
  }
  return bindings;
}

function expandTemplate(node, bindings) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (!ts.isTemplateExpression(node)) return [];
  const identifiers = [];
  for (const span of node.templateSpans) {
    if (!ts.isIdentifier(span.expression)) return [];
    if (!bindings.has(span.expression.text)) return [];
    if (!identifiers.includes(span.expression.text)) identifiers.push(span.expression.text);
  }
  let assignments = [new Map()];
  for (const identifier of identifiers) {
    assignments = assignments.flatMap((assignment) =>
      bindings.get(identifier).map((value) => new Map(assignment).set(identifier, value)),
    );
  }
  return assignments.map((assignment) => {
    let name = node.head.text;
    for (const span of node.templateSpans)
      name += assignment.get(span.expression.text) + span.literal.text;
    return name;
  });
}

export function declaredTestNamePatterns(path) {
  const sourceText = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = [];
  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === "test" || node.expression.text === "it")
      && node.arguments.length > 0
    ) {
      names.push(...expandTemplate(node.arguments[0], loopBindings(node)));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}

export function validateSelectedTestNamePattern(pattern, selectedFiles) {
  let expression;
  try {
    expression = new RegExp(pattern);
  } catch (error) {
    return { valid: false, reason: `Invalid --test-name-pattern: ${error instanceof Error ? error.message : String(error)}` };
  }
  const names = selectedFiles.flatMap(declaredTestNamePatterns);
  return names.some((name) => expression.test(name))
    ? { valid: true }
    : { valid: false, reason: "--test-name-pattern matched no statically resolved concrete tests in the selected files" };
}
