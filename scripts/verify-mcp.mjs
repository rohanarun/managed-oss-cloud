import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { suiteModules, suiteToolName } from "../dist-server/shared/suite.js";
import { suiteActionRequiredScope, suiteActionToolName, suiteActions } from "../dist-server/shared/suite-actions.js";

const client = new Client({ name: "supersuite-verifier", version: "0.2.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist-server/mcp/index.js"],
  env: { ...process.env, SUPERSUITE_TOKEN: "sup_verification_only", SUPERSUITE_URL: "http://127.0.0.1:9" },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const result = await client.listTools();
  const expectedCount = 3 + suiteModules.length + suiteActions.length;
  if (result.tools.length !== expectedCount) throw new Error(`Expected ${expectedCount} MCP tools, received ${result.tools.length}.`);
  const names = new Set(result.tools.map((tool) => tool.name));
  const requiredNames = ["suite_catalog", "suite_workspace", "suite_ai_status"];
  for (const module of suiteModules) requiredNames.push(suiteToolName(module.id, "list"));
  for (const action of suiteActions) requiredNames.push(suiteActionToolName(action));
  for (const required of requiredNames) {
    if (!names.has(required)) throw new Error(`Missing MCP tool: ${required}.`);
  }
  for (const module of suiteModules) {
    for (const removedBypass of [suiteToolName(module.id, "create"), suiteToolName(module.id, "ai")]) {
      if (names.has(removedBypass)) throw new Error(`Unsafe generic tool still exists: ${removedBypass}.`);
    }
    const removedGenericName = `${module.id.replaceAll("-", "_")}_action`;
    if (names.has(removedGenericName)) throw new Error(`Generic action selector still exists: ${removedGenericName}.`);
  }
  for (const action of suiteActions) {
    const tool = result.tools.find((candidate) => candidate.name === suiteActionToolName(action));
    const schema = tool?.inputSchema;
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const field of action.requiredFields) {
      if (!required.has(field)) throw new Error(`${tool?.name} does not require ${field}.`);
      if (!(field in properties)) throw new Error(`${tool?.name} does not describe ${field}.`);
    }
    const scope = suiteActionRequiredScope(action);
    if (tool?._meta?.["supersuite/requiredScope"] !== scope) throw new Error(`${tool?.name} does not advertise its ${scope} scope.`);
  }
  process.stdout.write(`${result.tools.length} MCP tools validated (${suiteActions.length} typed workflow actions across ${suiteModules.length} modules)\n`);
} finally {
  await client.close();
}
