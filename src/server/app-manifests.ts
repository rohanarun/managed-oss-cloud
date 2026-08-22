import { randomBytes } from "node:crypto";
import type { ApplicationInstance } from "../shared/types.js";

type ComposeService = Record<string, unknown>;

export interface RuntimeManifest {
  appId: string;
  internalPort: number;
  healthPath: string;
  primaryContainer: string;
  compose: {
    name: string;
    services: Record<string, ComposeService>;
    networks: Record<string, unknown>;
  };
}

export interface ManifestOptions {
  platformNetwork: string;
}

const reservations: Record<string, { memoryMb: number; cpuMillis: number }> = {
  "uptime-kuma": { memoryMb: 384, cpuMillis: 250 },
  listmonk: { memoryMb: 576, cpuMillis: 500 },
  umami: { memoryMb: 768, cpuMillis: 750 },
};

export function runtimeReservation(appId: string) {
  const reservation = reservations[appId];
  if (!reservation) throw new Error(`Application ${appId} has no verified runtime reservation.`);
  return reservation;
}

function secret(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}

function base(instance: ApplicationInstance, options: ManifestOptions) {
  return {
    name: instance.containerProject,
    networks: {
      private: { internal: true },
      platform: { external: true, name: options.platformNetwork },
    },
  };
}

export function buildRuntimeManifest(instance: ApplicationInstance, options: ManifestOptions): RuntimeManifest {
  const containerPrefix = instance.containerProject;
  switch (instance.appId) {
    case "uptime-kuma": {
      const primaryContainer = `${containerPrefix}-app`;
      return {
        appId: instance.appId,
        internalPort: 3001,
        healthPath: "/",
        primaryContainer,
        compose: {
          ...base(instance, options),
          services: {
            app: {
              image: "louislam/uptime-kuma:2.3.2@sha256:9aeb4e51d038047f414309c77a1af553281ca535723cb88907d907269d0a908e",
              container_name: primaryContainer,
              restart: "unless-stopped",
              volumes: ["./data:/app/data"],
              expose: ["3001"],
              networks: ["platform"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "384m",
              healthcheck: { test: ["CMD", "extra/healthcheck"], interval: "15s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "384M" } } },
              security_opt: ["no-new-privileges:true"],
            },
          },
        },
      };
    }
    case "listmonk": {
      const primaryContainer = `${containerPrefix}-app`;
      const databaseContainer = `${containerPrefix}-db`;
      const databasePassword = secret();
      return {
        appId: instance.appId,
        internalPort: 9000,
        healthPath: "/health",
        primaryContainer,
        compose: {
          ...base(instance, options),
          services: {
            app: {
              image: "listmonk/listmonk:v6.2.0@sha256:f535d59e14991337a9f2d570273685378ae86b0d7698c3e00da444e3bc205286",
              container_name: primaryContainer,
              restart: "unless-stopped",
              depends_on: { db: { condition: "service_healthy" } },
              command: ["sh", "-c", "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"],
              environment: {
                LISTMONK_app__address: "0.0.0.0:9000",
                LISTMONK_db__user: "listmonk",
                LISTMONK_db__password: databasePassword,
                LISTMONK_db__database: "listmonk",
                LISTMONK_db__host: "db",
                LISTMONK_db__port: "5432",
                LISTMONK_db__ssl_mode: "disable",
                LISTMONK_db__max_open: "10",
                LISTMONK_db__max_idle: "5",
              },
              volumes: ["./uploads:/listmonk/uploads:rw"],
              expose: ["9000"],
              networks: ["private", "platform"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "320m",
              deploy: { resources: { limits: { memory: "320M" } } },
              security_opt: ["no-new-privileges:true"],
            },
            db: {
              image: "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
              container_name: databaseContainer,
              restart: "unless-stopped",
              environment: { POSTGRES_USER: "listmonk", POSTGRES_PASSWORD: databasePassword, POSTGRES_DB: "listmonk" },
              volumes: ["./database:/var/lib/postgresql/data"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "256m",
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U listmonk -d listmonk"], interval: "10s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "256M" } } },
              security_opt: ["no-new-privileges:true"],
            },
          },
        },
      };
    }
    case "umami": {
      const primaryContainer = `${containerPrefix}-app`;
      const databaseContainer = `${containerPrefix}-db`;
      const databasePassword = secret();
      return {
        appId: instance.appId,
        internalPort: 3000,
        healthPath: "/api/heartbeat",
        primaryContainer,
        compose: {
          ...base(instance, options),
          services: {
            app: {
              image: "ghcr.io/umami-software/umami:3.3.1@sha256:fa32d116cf20cad52cbc3fad9a63b46e7fa02299d8f967168eb453d49c476b4a",
              container_name: primaryContainer,
              restart: "unless-stopped",
              init: true,
              depends_on: { db: { condition: "service_healthy" } },
              environment: {
                DATABASE_URL: `postgresql://umami:${databasePassword}@db:5432/umami`,
                APP_SECRET: secret(32),
                TWO_FACTOR_ENCRYPTION_KEY: secret(32),
              },
              expose: ["3000"],
              networks: ["private", "platform"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "512m",
              healthcheck: { test: ["CMD-SHELL", "curl -fsS http://localhost:3000/api/heartbeat || exit 1"], interval: "10s", timeout: "5s", retries: 18 },
              deploy: { resources: { limits: { memory: "512M" } } },
              security_opt: ["no-new-privileges:true"],
            },
            db: {
              image: "postgres:15-alpine@sha256:fe0737ba566a2c5b2a28f34433c0a423261900ec17b9bf7ad115e1aae7e57f1b",
              container_name: databaseContainer,
              restart: "unless-stopped",
              environment: { POSTGRES_DB: "umami", POSTGRES_USER: "umami", POSTGRES_PASSWORD: databasePassword },
              volumes: ["./database:/var/lib/postgresql/data"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "256m",
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U umami -d umami"], interval: "10s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "256M" } } },
              security_opt: ["no-new-privileges:true"],
            },
          },
        },
      };
    }
    default:
      throw new Error(`Application ${instance.appId} has no verified runtime manifest.`);
  }
}
