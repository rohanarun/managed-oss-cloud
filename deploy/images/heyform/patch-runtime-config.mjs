import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const insertionPoint = "            enableGoogleFonts: _environments_1.ENABLE_GOOGLE_FONTS,";
const replacement = `${insertionPoint}
            disableLoginWithGoogle: process.env.MANAGED_GOOGLE_BROKER_START_URL && process.env.MANAGED_OAUTH_ASSERTION_PUBLIC_KEY && process.env.MANAGED_OAUTH_APPLICATION_ID ? false : _environments_1.DISABLE_LOGIN_WITH_GOOGLE,
            disableLoginWithApple: _environments_1.DISABLE_LOGIN_WITH_APPLE,`;

export function patchRuntimeConfig(source) {
  if (!source.includes(insertionPoint)) throw new Error("The pinned HeyForm controller no longer matches the audited runtime-config shape.");
  if (source.includes("disableLoginWithGoogle:")) throw new Error("The pinned HeyForm image already contains the OAuth visibility fix; remove this derived-image patch.");
  return source.replace(insertionPoint, replacement);
}

function main() {
  const controllerPath = process.argv[2];
  if (!controllerPath) throw new Error("Provide the compiled HeyForm dashboard controller path.");
  writeFileSync(controllerPath, patchRuntimeConfig(readFileSync(controllerPath, "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
