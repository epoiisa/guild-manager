import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Exact compatibility readers/retirement routes; new sends are never exempt.
const legacyModels = new Set([
  "services/applications/intakePresentation.ts:refreshApplicationIntakeCard",
  "services/applications/intakePresentation.ts:retireIntakeMessageControls",
  "services/applications/intakePresentation.ts:withoutApplicationControls",
  "services/applications/intakePresentation.ts:fingerprint",
  "services/applications/intakePresentation.ts:findPublishedMessage",
  "services/content/messages.ts:presentationFingerprint"
]);
const textDelivery = new Set([
  "commands/memberGroupReport.ts:replyWithMemberGroupReport", // private report sentence and ordinary attachment
  "commands/message.ts:sendBotMessage", // officer-authored destination posts
  "services/content/signupApproval.ts:publish", // conversational approvals
  "services/logFeed/delivery.ts:send" // dedicated administrative feed
]);

test("operational deliveries explicitly select standard feedback or V2 without classic embeds or unclassified text", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(root);
  const problems: string[] = [];
  for (const path of files) {
    const file = relative(root, path);
    const source = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const context = (node: ts.Node): string => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isArrowFunction(parent)) {
          if ("name" in parent && parent.name) return parent.name.getText(source);
          if (ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText(source);
        }
      }
      return "module";
    };
    const inspect = (node: ts.Node) => {
      const key = `${file}:${context(node)}`;
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (property.name?.getText(source) !== "embeds") continue;
          if (ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer) && property.initializer.elements.length === 0) continue;
          if (!legacyModels.has(key)) problems.push(`${key}: populated classic embed payload`);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["send", "reply", "editReply", "followUp", "update", "edit"].includes(node.expression.name.text)
        && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const content = node.arguments[0].properties.find(property => property.name?.getText(source) === "content");
        if (content && !(ts.isPropertyAssignment(content) && content.initializer.kind === ts.SyntaxKind.NullKeyword) && !textDelivery.has(key)) {
          problems.push(`${key}: unclassified direct text delivery`);
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        if (["feedbackReply", "feedbackEdit", "feedbackMessage"].includes(callee)
          && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
          const flags = node.arguments[0].properties.find(property => property.name?.getText(source) === "flags");
          if (flags?.getText(source).includes("IsComponentsV2")) problems.push(`${key}: standard feedback must not request the V2 flag`);
        }
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "update"
          && node.arguments[0] && ts.isCallExpression(node.arguments[0])
          && ["feedbackEdit", "feedbackReply", "feedbackMessage"].includes(node.arguments[0].expression.getText(source))) {
          problems.push(`${key}: prompt feedback must use the compatible completion boundary`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  assert.deepEqual(problems, []);
});
