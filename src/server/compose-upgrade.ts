import { readFile, writeFile } from "node:fs/promises";

type ComposeDocument = {
  services?: {
    app?: {
      image?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export async function updateComposeApplicationImage(composePath: string, targetImage: string) {
  if (!targetImage.includes("@sha256:")) throw new Error("Managed upgrades require a digest-pinned application image.");
  const compose = JSON.parse(await readFile(composePath, "utf8")) as ComposeDocument;
  const application = compose.services?.app;
  if (!application || typeof application.image !== "string") throw new Error("Managed compose file has no application image to upgrade.");
  const previousImage = application.image;
  application.image = targetImage;
  await writeFile(composePath, `${JSON.stringify(compose, null, 2)}\n`, { mode: 0o600 });
  return { previousImage, targetImage };
}
