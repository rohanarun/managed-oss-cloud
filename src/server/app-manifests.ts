import { randomBytes } from "node:crypto";
import type { ApplicationInstance } from "../shared/types.js";

type ComposeService = Record<string, unknown>;

export interface RuntimeManifest {
  appId: string;
  internalPort: number;
  healthPath: string;
  primaryContainer: string;
  proxyContainer: string;
  readiness?: {
    path: string;
    acceptedEntryPageTypes: string[];
    rejectedEntryPageTypes: string[];
  };
  compose: {
    name: string;
    services: Record<string, ComposeService>;
    networks: Record<string, unknown>;
  };
}

export interface ManifestOptions {
  platformNetworkName?: string;
  googleOAuthBroker?: {
    startUrl: string;
    assertionPublicKey: string;
  };
}

const reservations: Record<string, { memoryMb: number; cpuMillis: number; storageGb: number }> = {
  "cal-diy": { memoryMb: 3104, cpuMillis: 1500, storageGb: 20 },
  documenso: { memoryMb: 2144, cpuMillis: 1000, storageGb: 20 },
  heyform: { memoryMb: 1344, cpuMillis: 750, storageGb: 20 },
  "uptime-kuma": { memoryMb: 416, cpuMillis: 250, storageGb: 3 },
  listmonk: { memoryMb: 608, cpuMillis: 500, storageGb: 10 },
  umami: { memoryMb: 800, cpuMillis: 750, storageGb: 10 },
};

export function runtimeReservation(appId: string) {
  const reservation = reservations[appId];
  if (!reservation) throw new Error(`Application ${appId} has no verified runtime reservation.`);
  return reservation;
}

function secret(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}

export function runtimeIngressNetwork(instance: Pick<ApplicationInstance, "containerProject">) {
  if (!/^mos-[0-9a-f]{12}$/i.test(instance.containerProject)) throw new Error("Invalid managed application container project.");
  return `${instance.containerProject}-ingress`;
}

function proxyService(instance: ApplicationInstance, internalPort: number, cpu = "0.025") {
  return {
    image: "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
    container_name: `${instance.containerProject}-proxy`,
    restart: "unless-stopped",
    depends_on: { app: { condition: "service_started" } },
    command: ["caddy", "reverse-proxy", "--from", ":8080", "--to", `app:${internalPort}`],
    expose: ["8080"],
    networks: ["ingress", "platform"],
    labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id, "com.getsupers.role": "fixed-upstream-proxy" },
    mem_limit: "32m",
    cpus: cpu,
    deploy: { resources: { limits: { memory: "32M", cpus: cpu } } },
    read_only: true,
    tmpfs: ["/data", "/config"],
    security_opt: ["no-new-privileges:true"],
  };
}

function base(instance: ApplicationInstance, options: ManifestOptions) {
  return {
    name: instance.containerProject,
    networks: {
      private: { internal: true },
      ingress: { external: true, name: runtimeIngressNetwork(instance) },
      platform: { external: true, name: options.platformNetworkName ?? "managed-oss-worker-platform" },
    },
  };
}

export function buildRuntimeManifest(instance: ApplicationInstance, options: ManifestOptions): RuntimeManifest {
  const containerPrefix = instance.containerProject;
  switch (instance.appId) {
    case "cal-diy": {
      const primaryContainer = `${containerPrefix}-app`;
      const databaseContainer = `${containerPrefix}-db`;
      const redisContainer = `${containerPrefix}-redis`;
      const databasePassword = secret();
      const publicUrl = `https://${instance.hostname}`;
      return {
        appId: instance.appId,
        internalPort: 3000,
        healthPath: "/",
        primaryContainer,
        proxyContainer: `${containerPrefix}-proxy`,
        compose: {
          ...base(instance, options),
          services: {
            proxy: proxyService(instance, 3000, "0.05"),
            app: {
              image: "calcom/cal.com:v6.2.0@sha256:ace3bb1219fb7306585ab9f4d94d41af7ee064c343db0498173436bbe857bd49",
              container_name: primaryContainer,
              restart: "unless-stopped",
              depends_on: { db: { condition: "service_healthy" }, redis: { condition: "service_healthy" } },
              environment: {
                DATABASE_HOST: "db:5432",
                DATABASE_URL: `postgresql://calcom:${databasePassword}@db:5432/calendso`,
                DATABASE_DIRECT_URL: `postgresql://calcom:${databasePassword}@db:5432/calendso`,
                REDIS_URL: "redis://redis:6379",
                NEXT_PUBLIC_WEBAPP_URL: publicUrl,
                NEXT_PUBLIC_WEBSITE_URL: publicUrl,
                NEXT_PUBLIC_EMBED_LIB_URL: `${publicUrl}/embed/embed.js`,
                NEXTAUTH_URL: publicUrl,
                NEXTAUTH_SECRET: secret(32),
                CALENDSO_ENCRYPTION_KEY: secret(24),
                NEXT_PUBLIC_LICENSE_CONSENT: "agree",
                CALCOM_TELEMETRY_DISABLED: "1",
                NODE_ENV: "production",
              },
              expose: ["3000"],
              networks: ["private", "ingress"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "2560m",
              cpus: "1.15",
              healthcheck: { test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:3000"], interval: "20s", timeout: "10s", retries: 30, start_period: "90s" },
              deploy: { resources: { limits: { memory: "2560M", cpus: "1.15" } } },
              security_opt: ["no-new-privileges:true"],
            },
            db: {
              image: "postgres:15-alpine@sha256:fe0737ba566a2c5b2a28f34433c0a423261900ec17b9bf7ad115e1aae7e57f1b",
              container_name: databaseContainer,
              restart: "unless-stopped",
              environment: { POSTGRES_USER: "calcom", POSTGRES_PASSWORD: databasePassword, POSTGRES_DB: "calendso" },
              volumes: ["./database:/var/lib/postgresql/data"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "384m",
              cpus: "0.2",
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U calcom -d calendso"], interval: "10s", timeout: "5s", retries: 18 },
              deploy: { resources: { limits: { memory: "384M", cpus: "0.2" } } },
              security_opt: ["no-new-privileges:true"],
            },
            redis: {
              image: "eqalpha/keydb:x86_64_v6.3.4@sha256:eceb1806730c7850395b8262300182c2e15a6e5dacbf0b72cbab110518caf43f",
              container_name: redisContainer,
              restart: "unless-stopped",
              command: ["keydb-server", "--appendonly", "yes", "--protected-mode", "no"],
              volumes: ["./redis:/data"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "128m",
              cpus: "0.1",
              healthcheck: { test: ["CMD", "keydb-cli", "ping"], interval: "10s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "128M", cpus: "0.1" } } },
              security_opt: ["no-new-privileges:true"],
            },
          },
        },
      };
    }
    case "documenso": {
      const primaryContainer = `${containerPrefix}-app`;
      const databaseContainer = `${containerPrefix}-db`;
      const certificateContainer = `${containerPrefix}-certificate`;
      const databasePassword = secret();
      const certificatePassword = secret();
      const publicUrl = `https://${instance.hostname}`;
      return {
        appId: instance.appId,
        internalPort: 3000,
        healthPath: "/api/health",
        primaryContainer,
        proxyContainer: `${containerPrefix}-proxy`,
        compose: {
          ...base(instance, options),
          services: {
            proxy: proxyService(instance, 3000, "0.05"),
            certificate: {
              image: "alpine/openssl:3.5.4@sha256:42c7389ef077aed0eb4e96d0abbd094083d701bbaff1313073b061c0c9cd8278",
              container_name: certificateContainer,
              environment: { CERTIFICATE_PASSWORD: certificatePassword },
              entrypoint: ["/bin/sh", "-c"],
              command: ["if [ ! -s /certificates/cert.p12 ]; then openssl req -x509 -newkey rsa:2048 -sha256 -nodes -keyout /tmp/key.pem -out /tmp/cert.pem -days 825 -subj '/CN=Managed Documenso Signing Certificate' && openssl pkcs12 -export -out /certificates/cert.p12 -inkey /tmp/key.pem -in /tmp/cert.pem -password env:CERTIFICATE_PASSWORD && chmod 0444 /certificates/cert.p12; fi"],
              volumes: ["./certificate:/certificates"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "64m",
              cpus: "0.05",
              deploy: { resources: { limits: { memory: "64M", cpus: "0.05" } } },
              security_opt: ["no-new-privileges:true"],
            },
            app: {
              image: "documenso/documenso:v2.17.0@sha256:1377ba20181d4d029e768b7b7615e4e49c39450a85588a525e78dc586dd2569c",
              container_name: primaryContainer,
              restart: "unless-stopped",
              depends_on: { db: { condition: "service_healthy" }, certificate: { condition: "service_completed_successfully" } },
              environment: {
                PORT: "3000",
                NEXTAUTH_SECRET: secret(32),
                NEXT_PRIVATE_ENCRYPTION_KEY: secret(32),
                NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY: secret(32),
                NEXT_PUBLIC_WEBAPP_URL: publicUrl,
                NEXT_PRIVATE_INTERNAL_WEBAPP_URL: "http://127.0.0.1:3000",
                NEXT_PRIVATE_DATABASE_URL: `postgresql://documenso:${databasePassword}@db:5432/documenso`,
                NEXT_PRIVATE_DIRECT_DATABASE_URL: `postgresql://documenso:${databasePassword}@db:5432/documenso`,
                NEXT_PRIVATE_SIGNING_TRANSPORT: "local",
                NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH: "/opt/documenso/certificates/cert.p12",
                NEXT_PRIVATE_SIGNING_PASSPHRASE: certificatePassword,
                NEXT_PUBLIC_UPLOAD_TRANSPORT: "database",
                NEXT_PRIVATE_SMTP_TRANSPORT: "smtp-auth",
                NEXT_PRIVATE_SMTP_HOST: "127.0.0.1",
                NEXT_PRIVATE_SMTP_PORT: "2525",
                NEXT_PRIVATE_SMTP_FROM_NAME: "Documenso",
                NEXT_PRIVATE_SMTP_FROM_ADDRESS: `noreply@${instance.hostname}`,
                DOCUMENSO_DISABLE_TELEMETRY: "true",
              },
              volumes: ["./certificate:/opt/documenso/certificates:ro"],
              expose: ["3000"],
              networks: ["private", "ingress"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "1792m",
              cpus: "0.7",
              healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(async r=>{const j=await r.json();process.exit(r.ok&&j.status==='ok'?0:1)}).catch(()=>process.exit(1))"], interval: "20s", timeout: "10s", retries: 30, start_period: "90s" },
              deploy: { resources: { limits: { memory: "1792M", cpus: "0.7" } } },
              security_opt: ["no-new-privileges:true"],
            },
            db: {
              image: "postgres:15-alpine@sha256:fe0737ba566a2c5b2a28f34433c0a423261900ec17b9bf7ad115e1aae7e57f1b",
              container_name: databaseContainer,
              restart: "unless-stopped",
              environment: { POSTGRES_USER: "documenso", POSTGRES_PASSWORD: databasePassword, POSTGRES_DB: "documenso" },
              volumes: ["./database:/var/lib/postgresql/data"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "256m",
              cpus: "0.2",
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U documenso -d documenso"], interval: "10s", timeout: "5s", retries: 18 },
              deploy: { resources: { limits: { memory: "256M", cpus: "0.2" } } },
              security_opt: ["no-new-privileges:true"],
            },
          },
        },
      };
    }
    case "heyform": {
      const primaryContainer = `${containerPrefix}-app`;
      const mongoContainer = `${containerPrefix}-mongo`;
      const redisContainer = `${containerPrefix}-redis`;
      const publicUrl = `https://${instance.hostname}`;
      return {
        appId: instance.appId,
        internalPort: 9157,
        healthPath: "/health/ready",
        primaryContainer,
        proxyContainer: `${containerPrefix}-proxy`,
        compose: {
          ...base(instance, options),
          services: {
            proxy: proxyService(instance, 9157, "0.05"),
            permissions: {
              image: "alpine/openssl:3.5.4@sha256:42c7389ef077aed0eb4e96d0abbd094083d701bbaff1313073b061c0c9cd8278",
              container_name: `${containerPrefix}-permissions`,
              entrypoint: ["/bin/sh", "-c"],
              command: ["mkdir -p /mongodb /uploads && chown -R 1001:1001 /mongodb && chmod 0770 /uploads"],
              volumes: ["./mongodb:/mongodb", "./uploads:/uploads"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "32m",
              cpus: "0.025",
              deploy: { resources: { limits: { memory: "32M", cpus: "0.025" } } },
              security_opt: ["no-new-privileges:true"],
            },
            app: {
              image: "ghcr.io/rohanarun/managed-oss-cloud/heyform-managed:sha-e828254@sha256:e3759e25780ea1b8141182feff6d86b8184cc647bf35d23322c0c4f8785810bf",
              container_name: primaryContainer,
              restart: "unless-stopped",
              depends_on: { permissions: { condition: "service_completed_successfully" }, mongo: { condition: "service_healthy" }, redis: { condition: "service_healthy" } },
              environment: {
                NODE_ENV: "production",
                APP_HOMEPAGE_URL: publicUrl,
                CORS_ALLOWED_ORIGINS: publicUrl,
                TRUST_PROXY: "1",
                ENABLE_GOOGLE_FONTS: "false",
                VERIFY_USER_EMAIL: "false",
                SESSION_KEY: secret(32),
                FORM_ENCRYPTION_KEY: secret(32),
                MONGO_URI: "mongodb://mongo:27017/heyform",
                REDIS_HOST: "redis",
                REDIS_PORT: "6379",
                ...(options.googleOAuthBroker ? {
                  MANAGED_GOOGLE_BROKER_START_URL: options.googleOAuthBroker.startUrl,
                  MANAGED_OAUTH_ASSERTION_PUBLIC_KEY: options.googleOAuthBroker.assertionPublicKey,
                  MANAGED_OAUTH_APPLICATION_ID: instance.id,
                } : {}),
              },
              volumes: ["./uploads:/app/packages/server/static/upload", "./uploads:/app/packages/server/uploads"],
              expose: ["9157"],
              networks: ["private", "ingress"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "768m",
              cpus: "0.4",
              healthcheck: { test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:9157/health/ready >/dev/null || exit 1"], interval: "15s", timeout: "5s", retries: 24, start_period: "45s" },
              deploy: { resources: { limits: { memory: "768M", cpus: "0.4" } } },
              security_opt: ["no-new-privileges:true"],
            },
            mongo: {
              image: "percona/percona-server-mongodb:4.4@sha256:dedeba0237c639dc5319b1bfa38f2558b9c268653bd555a727ea8df0babc05bb",
              container_name: mongoContainer,
              restart: "unless-stopped",
              depends_on: { permissions: { condition: "service_completed_successfully" } },
              volumes: ["./mongodb:/data/db"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "384m",
              cpus: "0.2",
              healthcheck: { test: ["CMD-SHELL", "mongo --quiet --eval 'db.runCommand({ ping: 1 }).ok' | grep 1"], interval: "10s", timeout: "5s", retries: 18 },
              deploy: { resources: { limits: { memory: "384M", cpus: "0.2" } } },
              security_opt: ["no-new-privileges:true"],
            },
            redis: {
              image: "eqalpha/keydb:x86_64_v6.3.4@sha256:eceb1806730c7850395b8262300182c2e15a6e5dacbf0b72cbab110518caf43f",
              container_name: redisContainer,
              restart: "unless-stopped",
              command: ["keydb-server", "--appendonly", "yes", "--protected-mode", "no"],
              volumes: ["./redis:/data"],
              networks: ["private"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "128m",
              cpus: "0.075",
              healthcheck: { test: ["CMD", "keydb-cli", "ping"], interval: "10s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "128M", cpus: "0.075" } } },
              security_opt: ["no-new-privileges:true"],
            },
          },
        },
      };
    }
    case "uptime-kuma": {
      const primaryContainer = `${containerPrefix}-app`;
      return {
        appId: instance.appId,
        internalPort: 3001,
        healthPath: "/",
        primaryContainer,
        proxyContainer: `${containerPrefix}-proxy`,
        readiness: { path: "/api/entry-page", acceptedEntryPageTypes: ["entryPage"], rejectedEntryPageTypes: ["setup-database"] },
        compose: {
          ...base(instance, options),
          services: {
            proxy: proxyService(instance, 3001),
            app: {
              image: "louislam/uptime-kuma:2.3.2@sha256:9aeb4e51d038047f414309c77a1af553281ca535723cb88907d907269d0a908e",
              container_name: primaryContainer,
              restart: "unless-stopped",
              environment: { UPTIME_KUMA_DB_TYPE: "sqlite" },
              volumes: ["./data:/app/data"],
              expose: ["3001"],
              networks: ["ingress"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "384m",
              cpus: "0.225",
              healthcheck: { test: ["CMD", "extra/healthcheck"], interval: "15s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "384M", cpus: "0.225" } } },
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
        proxyContainer: `${containerPrefix}-proxy`,
        compose: {
          ...base(instance, options),
          services: {
            proxy: proxyService(instance, 9000),
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
              networks: ["private", "ingress"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "320m",
              cpus: "0.275",
              deploy: { resources: { limits: { memory: "320M", cpus: "0.275" } } },
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
              cpus: "0.2",
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U listmonk -d listmonk"], interval: "10s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "256M", cpus: "0.2" } } },
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
        proxyContainer: `${containerPrefix}-proxy`,
        compose: {
          ...base(instance, options),
          services: {
            proxy: proxyService(instance, 3000),
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
              networks: ["private", "ingress"],
              labels: { "com.getsupers.managed": "true", "com.getsupers.application-instance": instance.id },
              mem_limit: "512m",
              cpus: "0.525",
              healthcheck: { test: ["CMD-SHELL", "curl -fsS http://localhost:3000/api/heartbeat || exit 1"], interval: "10s", timeout: "5s", retries: 18 },
              deploy: { resources: { limits: { memory: "512M", cpus: "0.525" } } },
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
              cpus: "0.2",
              healthcheck: { test: ["CMD-SHELL", "pg_isready -U umami -d umami"], interval: "10s", timeout: "5s", retries: 12 },
              deploy: { resources: { limits: { memory: "256M", cpus: "0.2" } } },
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
