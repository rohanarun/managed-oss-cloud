import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const terraform = readFileSync("infra/google-cloud/main.tf", "utf8");
const terraformVariables = readFileSync("infra/google-cloud/variables.tf", "utf8");
const workerCompose = readFileSync("deploy/google-cloud/worker/docker-compose.yml", "utf8");
const controlCompose = readFileSync("deploy/google-cloud/docker-compose.yml", "utf8");
const firewall = readFileSync("deploy/google-cloud/worker/metadata-firewall.sh", "utf8");
const dockerDropIn = readFileSync("deploy/google-cloud/worker/docker-metadata-firewall.conf", "utf8");
const firewallProof = readFileSync("deploy/google-cloud/metadata-firewall-proof.sh", "utf8");
const controlReadiness = readFileSync("deploy/google-cloud/readiness/control-plane-ready.sh", "utf8");
const workerResource = terraform.slice(terraform.indexOf('resource "google_compute_instance" "worker"'));
const controlResource = terraform.slice(terraform.indexOf('resource "google_compute_instance" "managed_oss"'), terraform.indexOf('resource "google_compute_instance" "worker"'));
const controlService = controlCompose.slice(controlCompose.indexOf("  control-plane:"), controlCompose.indexOf("  migrate:"));

describe("private worker metadata and OAuth isolation", () => {
  it("never grants or loads platform OAuth secrets on a worker", () => {
    expect(terraform).not.toContain('resource "google_secret_manager_secret_iam_member" "google_oauth_worker"');
    expect(workerResource).not.toMatch(/google_oauth_(client|state|callback|assertion_signing)_secret/i);
    expect(workerResource).not.toMatch(/GOOGLE_OAUTH_(CLIENT_ID|CLIENT_SECRET|STATE_SECRET|CALLBACK_URL|ASSERTION_SIGNING_PRIVATE_KEY)/);
    expect(workerResource).toContain("GOOGLE_OAUTH_BROKER_START_URL");
    expect(workerResource).toContain("GOOGLE_OAUTH_ASSERTION_PUBLIC_KEY");
  });

  it("loads the private OAuth environment only into the control-plane service", () => {
    expect(controlService).toContain("oauth.env");
    expect(controlCompose.slice(controlCompose.indexOf("  migrate:"))).not.toContain("oauth.env");
    const runtimeStart = terraform.indexOf("cat > /opt/managed-oss/config/runtime.env");
    const runtimeHereDoc = terraform.slice(runtimeStart, terraform.indexOf("\n    EOF", runtimeStart));
    expect(runtimeHereDoc).not.toMatch(/GOOGLE_OAUTH_(CLIENT_SECRET|STATE_SECRET|ASSERTION_SIGNING_PRIVATE_KEY)/);
  });

  it("limits operational secrets to the control-plane and gateway processes that use them", () => {
    const runtimeStart = terraform.indexOf("cat > /opt/managed-oss/config/runtime.env");
    const runtimeHereDoc = terraform.slice(runtimeStart, terraform.indexOf("\n    EOF", runtimeStart));
    for (const secret of ["WORKER_BOOTSTRAP_TOKEN", "GATEWAY_RECONCILER_TOKEN", "CONSENT_POLICY_SIGNING_PRIVATE_KEY", "CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS_JSON"]) {
      expect(runtimeHereDoc).not.toContain(secret);
    }
    expect(controlService).toContain("control-plane.env");
    expect(controlService).toContain("gateway.env");
    const untrustedServices = controlCompose.slice(controlCompose.indexOf("  migrate:"), controlCompose.indexOf("  gateway-reconciler:"));
    expect(untrustedServices).not.toContain("control-plane.env");
    expect(untrustedServices).not.toContain("gateway.env");
    const gatewayService = controlCompose.slice(controlCompose.indexOf("  gateway-reconciler:"), controlCompose.indexOf("  caddy:"));
    expect(gatewayService).toContain("gateway.env");
    expect(gatewayService).not.toContain("control-plane.env");
  });

  it("passes validated historical consent public keys only to the control-plane process", () => {
    expect(terraformVariables).toContain('variable "consent_policy_previous_public_keys"');
    expect(terraformVariables).toContain("default = []");
    expect(terraformVariables).toContain('key.algorithm == "Ed25519"');
    const controlEnvironmentStart = terraform.indexOf("cat > /opt/managed-oss/config/control-plane.env");
    const controlEnvironment = terraform.slice(controlEnvironmentStart, terraform.indexOf("\n    EOF", controlEnvironmentStart));
    expect(controlEnvironment).toContain("CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS_JSON=${jsonencode(var.consent_policy_previous_public_keys)}");
    expect(controlService).toContain("control-plane.env");
    expect(controlCompose.slice(controlCompose.indexOf("  migrate:"))).not.toMatch(/control-plane\.env[\s\S]*CONSENT_POLICY_PREVIOUS_PUBLIC_KEYS_JSON/);
  });

  it("keeps only the trusted agent on host networking and blocks bridge traffic to both metadata addresses", () => {
    expect(workerCompose.slice(workerCompose.indexOf("  agent:"), workerCompose.indexOf("  caddy:"))).toContain("network_mode: host");
    expect(firewall).toContain("DOCKER-USER");
    expect(firewall).toContain("169.254.169.254/32");
    expect(firewall).toContain("fd20:ce::254/128");
    expect(dockerDropIn).toContain("ExecStartPost=/opt/managed-oss/security/metadata-firewall.sh");
    expect(workerResource.indexOf("systemctl enable --now managed-oss-metadata-firewall.service")).toBeLessThan(workerResource.indexOf("docker network create managed-oss-worker-platform"));
  });

  it("installs and proves metadata isolation on the control VM before any Compose command", () => {
    const secretAccess = controlResource.indexOf("CONSENT_POLICY_SIGNING_PRIVATE_KEY=\"$(access_secret");
    const firewallEnable = controlResource.indexOf("systemctl enable --now managed-oss-metadata-firewall.service");
    const directPull = controlResource.indexOf('docker pull "$${CONTROL_PLANE_IMAGE}"');
    const firewallProofCall = controlResource.indexOf('metadata-firewall-proof.sh "$${CONTROL_PLANE_IMAGE}"');
    const firstCompose = controlResource.indexOf("docker-compose pull");
    expect(secretAccess).toBeGreaterThan(0);
    expect(firewallEnable).toBeGreaterThan(secretAccess);
    expect(directPull).toBeGreaterThan(firewallEnable);
    expect(firewallProofCall).toBeGreaterThan(directPull);
    expect(firstCompose).toBeGreaterThan(firewallProofCall);
    expect(firewallProof).toContain("--network bridge");
    expect(firewallProof).toContain("169.254.169.254");
    expect(firewallProof).toContain("fd20:ce::254");
    expect(firewallProof).toContain("metadata.google.internal");
    expect(firewall).toContain("verify_reject_rule iptables 169.254.169.254/32");
    expect(firewall).toContain("verify_reject_rule ip6tables fd20:ce::254/128");
    expect(controlReadiness).toContain('hosting_entitlement_mode" == "hosted" && -z "$metadata_firewall_proof_file"');
  });

  it("requires every worker to produce a real bridge-container metadata proof before Compose", () => {
    const install = workerResource.indexOf('filebase64("${path.module}/../../deploy/google-cloud/metadata-firewall-proof.sh")');
    const chmod = workerResource.indexOf("chmod 0750 /opt/managed-oss/security/metadata-firewall.sh /opt/managed-oss/security/metadata-firewall-proof.sh");
    const directPull = workerResource.indexOf('docker pull "$${CONTROL_PLANE_IMAGE}"');
    const proofCall = workerResource.indexOf('metadata-firewall-proof.sh "$${CONTROL_PLANE_IMAGE}"');
    const composePull = workerResource.indexOf("docker-compose pull");
    expect(install).toBeGreaterThan(0);
    expect(chmod).toBeGreaterThan(install);
    expect(directPull).toBeGreaterThan(0);
    expect(proofCall).toBeGreaterThan(directPull);
    expect(composePull).toBeGreaterThan(proofCall);
    expect(workerResource).toContain('MANAGED_OSS_METADATA_FIREWALL_PROOF_FILE="$${METADATA_PROOF}"');
    expect(readFileSync("deploy/google-cloud/readiness/worker-ready.sh", "utf8")).toContain("Worker metadata firewall proof is unavailable.");
  });
});
