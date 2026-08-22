import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateComposeApplicationImage } from "../src/server/compose-upgrade";

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
        app: { image: "example/app:v1@sha256:aaaaaaaa", environment: { SESSION_KEY: "preserve-this", FORM_ENCRYPTION_KEY: "also-preserve-this" }, volumes: ["./uploads:/app/uploads"] },
        db: { image: "mongo:7@sha256:bbbbbbbb", environment: { DATABASE_PASSWORD: "preserve-db-secret" } },
      },
      networks: { private: { internal: true } },
    };
    await writeFile(composePath, JSON.stringify(compose), { mode: 0o600 });

    await updateComposeApplicationImage(composePath, "ghcr.io/example/app:v2@sha256:cccccccc", { GOOGLE_LOGIN_CLIENT_ID: "platform-client" });

    const upgraded = JSON.parse(await readFile(composePath, "utf8"));
    expect(upgraded.services.app.image).toBe("ghcr.io/example/app:v2@sha256:cccccccc");
    expect(upgraded.services.app.environment).toEqual({ ...compose.services.app.environment, GOOGLE_LOGIN_CLIENT_ID: "platform-client" });
    expect(upgraded.services.app.volumes).toEqual(compose.services.app.volumes);
    expect(upgraded.services.db).toEqual(compose.services.db);
    expect(upgraded.networks).toEqual(compose.networks);
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
});
