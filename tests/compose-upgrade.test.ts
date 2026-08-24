import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateComposeIngressNetwork, migrateComposeResourceLimits, updateComposeApplicationImage } from "../src/server/compose-upgrade";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("managed compose upgrades", () => {
  it("changes only the digest-pinned app image and preserves generated secrets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-oss-compose-"));
    directories.push(directory);
    const composePath = path.join(directory, "compose.json");
    const compose = {
      name: "mos-example",
      services: {
        app: { image: "example/app:v1@sha256:aaaaaaaa", environment: { SESSION_KEY: "preserve-this", FORM_ENCRYPTION_KEY: "also-preserve-this", GOOGLE_LOGIN_CLIENT_ID: "legacy-client", GOOGLE_LOGIN_CLIENT_SECRET: "remove-private-client-secret", MANAGED_OAUTH_STATE_SECRET: "remove-private-state-secret", MANAGED_GOOGLE_CALLBACK_URL: "https://tenant.example.com/login/google/callback" }, volumes: ["./uploads:/app/uploads"] },
        db: { image: "mongo:7@sha256:bbbbbbbb", environment: { DATABASE_PASSWORD: "preserve-db-secret" } },
      },
      networks: { private: { internal: true } },
    };
    await writeFile(composePath, JSON.stringify(compose), { mode: 0o600 });

    const broker = {
      MANAGED_GOOGLE_BROKER_START_URL: "https://cloud.example.com/oauth/google/start",
      MANAGED_OAUTH_ASSERTION_PUBLIC_KEY: "public-verification-key",
      MANAGED_OAUTH_APPLICATION_ID: "11111111-2222-3333-4444-555555555555",
    };
    await updateComposeApplicationImage(composePath, "ghcr.io/example/app:v2@sha256:cccccccc", {
      set: broker,
      required: Object.keys(broker),
      remove: ["GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_LOGIN_CLIENT_SECRET", "MANAGED_OAUTH_STATE_SECRET", "MANAGED_GOOGLE_CALLBACK_URL"],
    });

    const upgraded = JSON.parse(await readFile(composePath, "utf8"));
    expect(upgraded.services.app.image).toBe("ghcr.io/example/app:v2@sha256:cccccccc");
    expect(upgraded.services.app.environment).toEqual({ SESSION_KEY: "preserve-this", FORM_ENCRYPTION_KEY: "also-preserve-this", ...broker });
    expect(JSON.stringify(upgraded.services.app.environment)).not.toMatch(/legacy-client|private-client-secret|private-state-secret|GOOGLE_LOGIN_CLIENT/);
    expect(upgraded.services.app.volumes).toEqual(compose.services.app.volumes);
    expect(upgraded.services.db).toEqual(compose.services.db);
    expect(upgraded.networks).toEqual(compose.networks);
  });

  it("fails closed when a managed environment synchronization omits a required public broker key", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-oss-compose-"));
    directories.push(directory);
    const composePath = path.join(directory, "compose.json");
    await writeFile(composePath, JSON.stringify({ services: { app: { image: "example/app:v1@sha256:aaaaaaaa", environment: { SESSION_KEY: "preserve" } } } }));
    await expect(updateComposeApplicationImage(composePath, "example/app:v2@sha256:bbbbbbbb", {
      set: { MANAGED_GOOGLE_BROKER_START_URL: "https://cloud.example.com/oauth/google/start" },
      remove: [],
      required: ["MANAGED_GOOGLE_BROKER_START_URL", "MANAGED_OAUTH_ASSERTION_PUBLIC_KEY", "MANAGED_OAUTH_APPLICATION_ID"],
    })).rejects.toThrow(/MANAGED_OAUTH_ASSERTION_PUBLIC_KEY/);
    expect(JSON.parse(await readFile(composePath, "utf8")).services.app.image).toBe("example/app:v1@sha256:aaaaaaaa");
  });

  it("rejects mutable tags and malformed compose files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-oss-compose-"));
    directories.push(directory);
    const composePath = path.join(directory, "compose.json");
    await writeFile(composePath, JSON.stringify({ services: { app: { image: "example/app:v1@sha256:aaaaaaaa" } } }));
    await expect(updateComposeApplicationImage(composePath, "example/app:latest")).rejects.toThrow(/digest-pinned/);
    await writeFile(composePath, JSON.stringify({ services: { db: { image: "postgres@sha256:bbbbbbbb" } } }));
    await expect(updateComposeApplicationImage(composePath, "example/app:v2@sha256:cccccccc")).rejects.toThrow(/no application image/);
  });

  it("migrates only the web container off the legacy shared network and preserves secrets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-oss-compose-"));
    directories.push(directory);
    const composePath = path.join(directory, "compose.json");
    const compose = {
      name: "mos-example",
      services: {
        app: { image: "example/app@sha256:aaaaaaaa", environment: { SESSION_KEY: "preserve" }, networks: ["private", "platform"] },
        db: { image: "postgres@sha256:bbbbbbbb", environment: { PASSWORD: "preserve-db" }, networks: ["private"] },
      },
      networks: { private: { internal: true }, platform: { external: true, name: "managed-oss-worker-platform" } },
    };
    await writeFile(composePath, JSON.stringify(compose), { mode: 0o600 });

    const proxy = { image: "caddy@sha256:cccccccc", container_name: "mos-111122223333-proxy", command: ["caddy", "reverse-proxy", "--from", ":8080", "--to", "app:9000"], networks: ["ingress", "platform"] };
    const platform = { external: true, name: "managed-oss-worker-platform" };
    expect(await migrateComposeIngressNetwork(composePath, "mos-111122223333-ingress", proxy, platform)).toEqual({ changed: true, ingressNetworkName: "mos-111122223333-ingress" });
    const migrated = JSON.parse(await readFile(composePath, "utf8"));
    expect(migrated.services.app.networks).toEqual(["private", "ingress"]);
    expect(migrated.services.proxy).toEqual(proxy);
    expect(migrated.services.app.environment).toEqual(compose.services.app.environment);
    expect(migrated.services.db).toEqual(compose.services.db);
    expect(migrated.networks).toEqual({ private: { internal: true }, platform, ingress: { external: true, name: "mos-111122223333-ingress" } });
    expect(await migrateComposeIngressNetwork(composePath, "mos-111122223333-ingress", proxy, platform)).toEqual({ changed: false, ingressNetworkName: "mos-111122223333-ingress" });
  });

  it("refuses to migrate an internal service that was attached to the shared network", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-oss-compose-"));
    directories.push(directory);
    const composePath = path.join(directory, "compose.json");
    await writeFile(composePath, JSON.stringify({ services: { app: { networks: ["platform"] }, db: { networks: ["private", "platform"] } }, networks: { platform: { external: true } } }));
    await expect(migrateComposeIngressNetwork(composePath, "mos-111122223333-ingress", { networks: ["ingress", "platform"] }, { external: true, name: "managed-oss-worker-platform" })).rejects.toThrow(/internal service db/);
  });

  it("adds exact CPU and memory limits to every existing service without changing secrets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "managed-oss-compose-"));
    directories.push(directory);
    const composePath = path.join(directory, "compose.json");
    const compose = { services: { app: { image: "app@sha256:aaaa", environment: { SECRET: "preserve" } }, db: { image: "db@sha256:bbbb", environment: { PASSWORD: "preserve-db" } } } };
    await writeFile(composePath, JSON.stringify(compose));
    const target = {
      app: { mem_limit: "512m", cpus: "0.5", deploy: { resources: { limits: { memory: "512M", cpus: "0.5" } } } },
      db: { mem_limit: "256m", cpus: "0.2", deploy: { resources: { limits: { memory: "256M", cpus: "0.2" } } } },
    };
    expect(await migrateComposeResourceLimits(composePath, target)).toEqual({ changed: true });
    const migrated = JSON.parse(await readFile(composePath, "utf8"));
    expect(migrated.services.app).toMatchObject({ image: compose.services.app.image, environment: compose.services.app.environment, ...target.app });
    expect(migrated.services.db).toMatchObject({ image: compose.services.db.image, environment: compose.services.db.environment, ...target.db });
    expect(await migrateComposeResourceLimits(composePath, target)).toEqual({ changed: false });
  });
});
