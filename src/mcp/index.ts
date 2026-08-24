#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { suiteModules, suiteToolName } from "../shared/suite.js";
import { managedOssPackageVersion } from "../shared/package-version.js";
import { suiteActionRequiredScope, suiteActionToolName, suiteActionsByModule } from "../shared/suite-actions.js";
import { clientFromEnvironment } from "../cli/client.js";
import { suiteActionMcpInput, suiteActionMcpInputShape } from "./action-schema.js";

const client = clientFromEnvironment();
const server = new McpServer({ name: "supersuite", version: managedOssPackageVersion() });
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });

server.registerTool("suite_catalog", {
  title: "List SuperSuite modules",
  description: "Lists every available MIT-native business module, its plan, record types, and AI capabilities.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => output({ modules: suiteModules }));

server.registerTool("suite_workspace", {
  title: "Read workspace",
  description: "Reads the authenticated workspace, enabled modules, and plan. Requires the read scope.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { "supersuite/requiredScope": "read" },
}, async () => output(await client.request("/api/suite/workspace")));

server.registerTool("suite_ai_status", {
  title: "Read AI action status",
  description: "Reads a queued, running, completed, or failed AI action by ID. Requires the read scope.",
  inputSchema: { actionId: z.string().uuid() },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { "supersuite/requiredScope": "read" },
}, async ({ actionId }) => output(await client.request(`/api/suite/ai-actions/${actionId}`)));

for (const module of suiteModules) {
  const actions = suiteActionsByModule.get(module.id) ?? [];
  server.registerTool(suiteToolName(module.id, "list"), {
    title: `List ${module.name} records`,
    description: `Lists workspace records owned by ${module.name}. Requires the read scope.`,
    inputSchema: { recordType: z.enum(module.recordTypes as [string, ...string[]]).optional(), limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { "supersuite/requiredScope": "read", "supersuite/moduleId": module.id },
  }, async ({ recordType, limit }) => {
    const query = new URLSearchParams({ moduleId: module.id, limit: String(limit) });
    if (recordType) query.set("recordType", recordType);
    return output(await client.request(`/api/suite/records?${query}`));
  });

  for (const action of actions) {
    const requiredScope = suiteActionRequiredScope(action);
    server.registerTool(suiteActionToolName(action), {
      title: action.title,
      description: `${action.description} Required fields: ${action.requiredFields.join(", ")}. Requires the ${requiredScope} scope.`,
      inputSchema: suiteActionMcpInputShape(action),
      annotations: {
        readOnlyHint: action.operation === "read",
        destructiveHint: action.destructive === true || action.id === "revoke-testimonial" || action.id === "draw-winner",
        idempotentHint: action.idempotent === true,
        openWorldHint: false,
      },
      _meta: { "supersuite/requiredScope": requiredScope, "supersuite/moduleId": module.id, "supersuite/actionId": action.id },
    }, async (args) => output(await client.request(`/api/suite/modules/${module.id}/actions/${action.id}`, { method: "POST", body: JSON.stringify({ input: suiteActionMcpInput(args as Record<string, unknown>) }) })));
  }
}

await server.connect(new StdioServerTransport());
