export interface SuiteClientOptions { baseUrl: string; token: string }

export class SuiteClient {
  constructor(private readonly options: SuiteClientOptions) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.options.baseUrl), {
      ...init,
      headers: { "Authorization": `Bearer ${this.options.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed with HTTP ${response.status}.`);
    return body as T;
  }
}

export function clientFromEnvironment() {
  const token = process.env.SUPERSUITE_TOKEN;
  if (!token) throw new Error("Set SUPERSUITE_TOKEN to a token created from the workspace dashboard.");
  return new SuiteClient({ baseUrl: process.env.SUPERSUITE_URL ?? "https://cloud.getsupers.com", token });
}
