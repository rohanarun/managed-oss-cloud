#!/usr/bin/env node
import { suiteModuleById, suiteModules } from "../shared/suite.js";
import { suiteAction, suiteActions, suiteActionsByModule } from "../shared/suite-actions.js";
import { describeSuiteAction, parseJsonObject, validateSuiteActionInput } from "./action-input.js";
import { clientFromEnvironment } from "./client.js";

function usage() {
  return `SuperSuite CLI

Usage:
  supersuite modules
  supersuite actions [module]
  supersuite action-help <module> <action>
  supersuite workspace
  supersuite enable <module>
  supersuite list <module> [record-type]
  supersuite ai-status <action-id>
  supersuite action <module> <action> <json-input>

API token scopes:
  read   workspace, list, and ai-status
  write  enable and typed non-AI actions
  ai     typed AI workflow actions

Environment:
  SUPERSUITE_TOKEN  Scoped API token created in the dashboard
  SUPERSUITE_URL    API origin, defaults to https://cloud.getsupers.com`;
}

function moduleOrThrow(id: string | undefined) {
  const module = id ? suiteModuleById.get(id) : undefined;
  if (!module) throw new Error(`Unknown module. Choose one of: ${suiteModules.map((item) => item.id).join(", ")}.`);
  return module;
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") return process.stdout.write(`${usage()}\n`);
  if (command === "modules") return process.stdout.write(`${JSON.stringify(suiteModules, null, 2)}\n`);
  if (command === "actions") {
    const actions = args[0] ? suiteActionsByModule.get(moduleOrThrow(args[0]).id) ?? [] : suiteActions;
    return process.stdout.write(`${JSON.stringify(actions.map(describeSuiteAction), null, 2)}\n`);
  }
  if (command === "action-help" || command === "action" && args[2] === "--help") {
    const module = moduleOrThrow(args[0]);
    const action = args[1] ? suiteAction(module.id, args[1]) : undefined;
    if (!action) throw new Error(`Usage: supersuite action-help ${module.id} <${(suiteActionsByModule.get(module.id) ?? []).map((item) => item.id).join("|")}>`);
    return process.stdout.write(`${JSON.stringify(describeSuiteAction(action), null, 2)}\n`);
  }
  const client = clientFromEnvironment();
  let result: unknown;
  switch (command) {
    case "workspace":
      result = await client.request("/api/suite/workspace");
      break;
    case "enable": {
      const module = moduleOrThrow(args[0]);
      result = await client.request(`/api/suite/modules/${module.id}/enable`, { method: "POST" });
      break;
    }
    case "list": {
      const module = moduleOrThrow(args[0]);
      const query = new URLSearchParams({ moduleId: module.id });
      if (args[1]) query.set("recordType", args[1]);
      result = await client.request(`/api/suite/records?${query}`);
      break;
    }
    case "ai-status":
      if (!args[0]) throw new Error("Usage: supersuite ai-status <action-id>");
      result = await client.request(`/api/suite/ai-actions/${args[0]}`);
      break;
    case "action": {
      const module = moduleOrThrow(args[0]);
      const actionId = args[1];
      const actions = suiteActionsByModule.get(module.id) ?? [];
      if (!actionId || !actions.some((action) => action.id === actionId)) throw new Error(`Usage: supersuite action ${module.id} <${actions.map((action) => action.id).join("|")}> <json-input>`);
      const action = suiteAction(module.id, actionId)!;
      const input = validateSuiteActionInput(action, parseJsonObject(args[2], "json-input", true));
      result = await client.request(`/api/suite/modules/${module.id}/actions/${actionId}`, { method: "POST", body: JSON.stringify({ input }) });
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}.\n\n${usage()}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
