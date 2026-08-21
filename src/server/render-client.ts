import { z } from "zod";

const renderErrorSchema = z.object({ message: z.string().optional() }).passthrough();

export interface RenderClientOptions {
  apiKey: string;
  ownerId: string;
  region: string;
  fetcher?: typeof fetch;
}

export interface CreateApplianceInput {
  name: string;
  plan: string;
  imageUrl: string;
  environment: Record<string, string>;
}

export class RenderClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: RenderClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetcher(`https://api.render.com/v1${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const parsed = renderErrorSchema.safeParse(await response.json().catch(() => ({})));
      throw new Error(parsed.success && parsed.data.message ? parsed.data.message : `Render API returned ${response.status}`);
    }
    return response.json();
  }

  createAppliance(input: CreateApplianceInput) {
    return this.request("/services", {
      method: "POST",
      body: JSON.stringify({
        type: "web_service",
        name: input.name,
        ownerId: this.options.ownerId,
        serviceDetails: {
          runtime: "image",
          plan: input.plan,
          region: this.options.region,
          image: { imagePath: input.imageUrl },
          envVars: Object.entries(input.environment).map(([key, value]) => ({ key, value })),
          healthCheckPath: "/health",
        },
      }),
    });
  }

  updatePlan(serviceId: string, plan: string) {
    return this.request(`/services/${encodeURIComponent(serviceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ serviceDetails: { plan } }),
    });
  }

  triggerDeploy(serviceId: string) {
    return this.request(`/services/${encodeURIComponent(serviceId)}/deploys`, {
      method: "POST",
      body: JSON.stringify({ clearCache: "do_not_clear" }),
    });
  }

  addCustomDomain(serviceId: string, domain: string) {
    return this.request(`/services/${encodeURIComponent(serviceId)}/custom-domains`, {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    });
  }
}
