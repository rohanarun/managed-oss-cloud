export function isMissingDockerNetworkFailure(message: string) {
  return /\bno such network\b/i.test(message)
    || /(?:^|\n)(?:error response from daemon:\s*)?network\s+\S+\s+not found\b/i.test(message);
}
