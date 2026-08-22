import { readFileSync, writeFileSync } from "node:fs";

const controllerPath = process.argv[2];
if (!controllerPath) throw new Error("Provide the compiled HeyForm dashboard controller path.");

const source = readFileSync(controllerPath, "utf8");
const insertionPoint = "            enableGoogleFonts: _environments_1.ENABLE_GOOGLE_FONTS,";
const replacement = `${insertionPoint}\n            disableLoginWithGoogle: _environments_1.DISABLE_LOGIN_WITH_GOOGLE,\n            disableLoginWithApple: _environments_1.DISABLE_LOGIN_WITH_APPLE,`;

if (!source.includes(insertionPoint)) throw new Error("The pinned HeyForm controller no longer matches the audited runtime-config shape.");
if (source.includes("disableLoginWithGoogle:")) throw new Error("The pinned HeyForm image already contains the OAuth visibility fix; remove this derived-image patch.");

writeFileSync(controllerPath, source.replace(insertionPoint, replacement));
