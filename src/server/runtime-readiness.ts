import type { RuntimeManifest } from "./app-manifests.js";

export function runtimeReadinessIssue(manifest: RuntimeManifest, response: unknown): string | undefined {
  if (!manifest.readiness) return undefined;
  if (!response || typeof response !== "object" || Array.isArray(response)) return `Application ${manifest.appId} returned an invalid readiness response from ${manifest.readiness.path}.`;
  const entryPageType = (response as { type?: unknown }).type;
  if (typeof entryPageType === "string" && manifest.readiness.rejectedEntryPageTypes.includes(entryPageType)) {
    return `Application ${manifest.appId} still requires database setup (${entryPageType}). Automated database initialization did not complete; verify that its persistent data directory is writable, then retry provisioning.`;
  }
  if (typeof entryPageType !== "string" || !manifest.readiness.acceptedEntryPageTypes.includes(entryPageType)) return `Application ${manifest.appId} returned an unexpected readiness state from ${manifest.readiness.path}.`;
  return undefined;
}
