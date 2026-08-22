import { readFileSync, writeFileSync } from "node:fs";

const servicePath = process.argv[2];
if (!servicePath) throw new Error("Provide the compiled HeyForm social-login service path.");

let source = readFileSync(servicePath, "utf8");
const importPoint = 'const _utils_1 = require("../utils");';
const helper = `const crypto_1 = require("node:crypto");
function managedGoogleState(state) {
    const secret = process.env.MANAGED_OAUTH_STATE_SECRET;
    const callbackUrl = process.env.MANAGED_GOOGLE_CALLBACK_URL;
    if (!secret || !callbackUrl)
        return state;
    const payload = Buffer.from(JSON.stringify({ origin: _environments_1.APP_HOMEPAGE_URL, state }), "utf8").toString("base64url");
    const signature = (0, crypto_1.createHmac)("sha256", secret).update(payload).digest("base64url");
    return \`\${payload}.\${signature}\`;
}`;
const callbackPoint = '    static callbackUrl(kind) {\n        return `${_environments_1.APP_HOMEPAGE_URL}/connect/${kind}/callback`;\n    }';
const callbackReplacement = '    static callbackUrl(kind) {\n        if (kind === shared_types_enums_1.SocialLoginTypeEnum.GOOGLE && process.env.MANAGED_GOOGLE_CALLBACK_URL)\n            return process.env.MANAGED_GOOGLE_CALLBACK_URL;\n        return `${_environments_1.APP_HOMEPAGE_URL}/connect/${kind}/callback`;\n    }';
const statePoint = 'Object.assign(Object.assign({}, googleOptions), { redirectUrl,\n                    state }))';
const stateReplacement = 'Object.assign(Object.assign({}, googleOptions), { redirectUrl,\n                    state: managedGoogleState(state) }))';

for (const point of [importPoint, callbackPoint, statePoint]) {
  if (!source.includes(point)) throw new Error("The pinned HeyForm social-login service no longer matches the audited platform OAuth shape.");
}
if (source.includes("managedGoogleState")) throw new Error("The pinned HeyForm image already contains the platform OAuth patch; remove this derived-image patch.");
source = source.replace(importPoint, `${importPoint}\n${helper}`).replace(callbackPoint, callbackReplacement).replace(statePoint, stateReplacement);
writeFileSync(servicePath, source);
