import { describe, expect, it } from "vitest";
import { isMissingDockerNetworkFailure } from "../src/server/docker-network-error.js";

describe("provisioning worker Docker network errors", () => {
  it("accepts both Docker missing-network responses and rejects unrelated failures", () => {
    expect(isMissingDockerNetworkFailure("Error response from daemon: network mos-ingress-example not found")).toBe(true);
    expect(isMissingDockerNetworkFailure("Error: No such network: mos-ingress-example")).toBe(true);
    expect(isMissingDockerNetworkFailure("permission denied while trying to connect to the Docker daemon socket")).toBe(false);
  });
});
