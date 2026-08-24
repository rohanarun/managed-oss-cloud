import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const serviceImportPoint = 'const _utils_1 = require("../utils");';
const serviceHelper = `const managed_oauth_crypto_1 = require("node:crypto");
function managedGoogleConfiguration(requestOrigin) {
    const startUrl = process.env.MANAGED_GOOGLE_BROKER_START_URL;
    const assertionPublicKey = process.env.MANAGED_OAUTH_ASSERTION_PUBLIC_KEY;
    const applicationId = process.env.MANAGED_OAUTH_APPLICATION_ID;
    if (!startUrl && !assertionPublicKey && !applicationId)
        return undefined;
    if (typeof startUrl !== "string" || typeof assertionPublicKey !== "string" || typeof applicationId !== "string" || !/^[0-9a-f-]{36}$/i.test(applicationId))
        throw new Error("Managed Google OAuth broker configuration is incomplete.");
    let start;
    let origin;
    let publicKey;
    try {
        start = new URL(startUrl);
        origin = new URL(requestOrigin);
        publicKey = (0, managed_oauth_crypto_1.createPublicKey)({ key: Buffer.from(assertionPublicKey, "base64"), format: "der", type: "spki" });
    }
    catch (_) {
        throw new Error("Managed Google OAuth broker configuration is invalid.");
    }
    if (start.protocol !== "https:" || start.username || start.password || start.search || start.hash || start.pathname !== "/oauth/google/start")
        throw new Error("Managed Google OAuth broker start URL is invalid.");
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.search || origin.hash || origin.pathname !== "/")
        throw new Error("Managed Google OAuth application origin is invalid.");
    if (publicKey.asymmetricKeyType !== "ed25519")
        throw new Error("Managed Google OAuth assertion key must be Ed25519.");
    const keyId = (0, managed_oauth_crypto_1.createHash)("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 24);
    return { startUrl: start.toString(), issuer: start.origin, origin: origin.origin, applicationId, publicKey, keyId };
}
function managedGoogleAuthUrl(state, requestOrigin) {
    const configuration = managedGoogleConfiguration(requestOrigin);
    if (!configuration)
        return undefined;
    if (typeof state !== "string" || state.length < 8 || state.length > 2000)
        throw new Error("Managed Google OAuth upstream state is invalid.");
    const target = new URL(configuration.startUrl);
    target.searchParams.set("application_id", configuration.applicationId);
    target.searchParams.set("origin", configuration.origin);
    target.searchParams.set("upstream_state", state);
    return target.toString();
}
function managedGoogleUserInfo(assertion, upstreamState, requestOrigin) {
    const configuration = managedGoogleConfiguration(requestOrigin);
    if (!configuration)
        return undefined;
    if (typeof assertion !== "string" || assertion.length < 64 || assertion.length > 8000 || typeof upstreamState !== "string" || upstreamState.length < 8 || upstreamState.length > 2000)
        throw new common_1.BadRequestException("Invalid managed Google identity assertion");
    const parts = assertion.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)))
        throw new common_1.BadRequestException("Invalid managed Google identity assertion");
    let header;
    let payload;
    try {
        header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    }
    catch (_) {
        throw new common_1.BadRequestException("Invalid managed Google identity assertion");
    }
    const now = Math.floor(Date.now() / 1000);
    const expectedStateHash = (0, managed_oauth_crypto_1.createHash)("sha256").update(upstreamState).digest("hex");
    const validShape = header && Object.keys(header).length === 3 && header.alg === "EdDSA" && header.typ === "JWT" && header.kid === configuration.keyId && payload && payload.iss === configuration.issuer && payload.aud === configuration.origin && payload.provider === "google" && typeof payload.sub === "string" && payload.sub.length >= 1 && payload.sub.length <= 512 && typeof payload.email === "string" && payload.email.length <= 320 && payload.email_verified === true && typeof payload.name === "string" && payload.name.length >= 1 && payload.name.length <= 300 && typeof payload.flow_id === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(payload.flow_id) && payload.state_hash === expectedStateHash && Number.isInteger(payload.iat) && Number.isInteger(payload.exp) && payload.iat <= now + 30 && payload.exp > now && payload.exp - payload.iat === 90;
    if (!validShape || !(0, managed_oauth_crypto_1.verify)(null, Buffer.from(parts[0] + "." + parts[1]), configuration.publicKey, Buffer.from(parts[2], "base64url")))
        throw new common_1.BadRequestException("Invalid managed Google identity assertion");
    const normalizedEmail = payload.email.trim().toLowerCase();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(normalizedEmail))
        throw new common_1.BadRequestException("Invalid managed Google identity assertion");
    const assertedLocale = typeof payload.locale === "string" ? payload.locale.trim().toLowerCase() : "";
    const user = { email: normalizedEmail, name: payload.name, avatar: typeof payload.picture === "string" && payload.picture.length <= 2048 ? payload.picture : "", lang: ["en", "pt-br", "zh-cn"].includes(assertedLocale) ? assertedLocale : "en" };
    return { openId: payload.sub, user };
}`;

const googleAuthPoint = `            case shared_types_enums_1.SocialLoginTypeEnum.GOOGLE:
                return (0, _utils_1.googleLoginUrl)(Object.assign(Object.assign({}, googleOptions), { redirectUrl,
                    state }));`;
const authUrlSignaturePoint = "    authUrl(kind, state) {";
const authUrlSignatureReplacement = "    authUrl(kind, state, requestOrigin) {";
const googleAuthReplacement = `            case shared_types_enums_1.SocialLoginTypeEnum.GOOGLE: {
                const managedUrl = managedGoogleAuthUrl(state, requestOrigin);
                if (managedUrl)
                    return managedUrl;
                return (0, _utils_1.googleLoginUrl)(Object.assign(Object.assign({}, googleOptions), { redirectUrl,
                    state }));
            }`;
const userInfoSignaturePoint = "    async userInfo(kind, code) {";
const userInfoSignatureReplacement = "    async userInfo(kind, code, upstreamState, requestOrigin) {";
const googleUserInfoPoint = `            case shared_types_enums_1.SocialLoginTypeEnum.GOOGLE:
                return await (0, _utils_1.googleUserInfo)(code, Object.assign(Object.assign({}, googleOptions), { redirectUrl }));`;
const googleUserInfoReplacement = `            case shared_types_enums_1.SocialLoginTypeEnum.GOOGLE: {
                const managedUser = managedGoogleUserInfo(code, upstreamState, requestOrigin);
                if (managedUser)
                    return managedUser;
                return await (0, _utils_1.googleUserInfo)(code, Object.assign(Object.assign({}, googleOptions), { redirectUrl }));
            }`;
const authCallbackSignaturePoint = "    async authCallback(kind, code) {";
const authCallbackSignatureReplacement = "    async authCallback(kind, code, upstreamState, requestOrigin) {";
const authCallbackCallPoint = "        const userInfo = await this.userInfo(kind, code);";
const authCallbackCallReplacement = "        const userInfo = await this.userInfo(kind, code, upstreamState, requestOrigin);";

const controllerInsertionPoint = "const OAUTH_STATE_TTL = '10m';";
const controllerHelper = `function managedOAuthRequestOrigin(req) {
    const host = req && typeof req.get === "function" ? req.get("host") : undefined;
    if (typeof host !== "string" || host.length < 1 || host.length > 253)
        throw new common_1.BadRequestException("Invalid managed OAuth request origin");
    let origin;
    try {
        origin = new URL("https://" + host);
    }
    catch (_) {
        throw new common_1.BadRequestException("Invalid managed OAuth request origin");
    }
    if (origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash || !origin.hostname || origin.hostname.startsWith("[") || /^\\d+(?:\\.\\d+){3}$/.test(origin.hostname) || origin.hostname === "localhost" || origin.hostname.endsWith(".localhost") || origin.hostname.endsWith(".local") || origin.hostname.endsWith(".internal") || origin.hostname.endsWith(".home.arpa"))
        throw new common_1.BadRequestException("Invalid managed OAuth request origin");
    return origin.origin;
}
function managedOAuthFailureReason(kind, query, error) {
    if (!query || typeof query !== "object" || utils_1.helper.isEmpty(query.state))
        return "missing_state";
    if (kind === shared_types_enums_1.SocialLoginTypeEnum.GOOGLE && utils_1.helper.isEmpty(query.assertion))
        return query.error ? "provider_denied" : "missing_assertion";
    if (error instanceof Error && error.message === "Invalid OAuth state")
        return "invalid_state";
    return "callback_failed";
}
function managedOAuthLogLine(kind, query, error, reason) {
    const safeKind = String(kind || "unknown").replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "unknown";
    const errorType = error && error.constructor && typeof error.constructor.name === "string"
        ? error.constructor.name.replace(/[^a-z0-9_-]/gi, "").slice(0, 48)
        : "UnknownError";
    return \`managed_oauth_callback_failed kind=\${safeKind} reason=\${reason} state_present=\${Boolean(query && query.state)} assertion_present=\${Boolean(query && query.assertion)} error_type=\${errorType}\`;
}
function renderManagedOAuthError(res, reason) {
    const retryable = reason === "callback_failed";
    const status = retryable ? 502 : 400;
    if (res.headersSent)
        return res.end();
    res.status(status);
    res.set("Cache-Control", "no-store");
    res.type("html");
    return res.send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Google sign-in unavailable</title><main style="max-width:38rem;margin:12vh auto;padding:1.5rem;font:16px system-ui;color:#171717"><h1>Google sign-in could not be completed</h1><p>No account session was created. Return to sign in and try again.</p><p><a href="/login">Return to sign in</a></p></main></html>');
}`;
const callbackStartPoint = `        try {
            await this.authService.verifyOAuthState(req, res, query.state);
            const userId = await this.socialLoginService.authCallback(kind, query.code || query.credential);`;
const callbackStartReplacement = `        try {
            if (!query || typeof query !== "object" || utils_1.helper.isEmpty(query.state))
                throw new common_1.BadRequestException("Invalid OAuth state");
            await this.authService.verifyOAuthState(req, res, query.state);
            if (kind === shared_types_enums_1.SocialLoginTypeEnum.GOOGLE && (query.error || utils_1.helper.isEmpty(query.assertion)))
                throw new common_1.BadRequestException(query.error ? "Google authorization was denied" : "Missing managed Google assertion");
            const credential = kind === shared_types_enums_1.SocialLoginTypeEnum.GOOGLE ? query.assertion : query.code || query.credential;
            const userId = await this.socialLoginService.authCallback(kind, credential, query.state, managedOAuthRequestOrigin(req));`;
const authUrlCallPoint = "        const authUrl = this.socialLoginService.authUrl(kind, oauthState);";
const authUrlCallReplacement = "        const authUrl = this.socialLoginService.authUrl(kind, oauthState, managedOAuthRequestOrigin(req));";
const callbackCatchPoint = `        catch (err) {
            this.logger.error(err);
            res.render('index', {
                data: {
                    error: \`unable_connect_\${kind}\`.toUpperCase()
                }
            });
        }`;
const callbackCatchReplacement = `        catch (err) {
            const reason = managedOAuthFailureReason(kind, query, err);
            this.logger.error(managedOAuthLogLine(kind, query, err, reason));
            return renderManagedOAuthError(res, reason);
        }`;
const missingStateRenderPoint = `            return res.render('index', {
                payload: {
                    error: \`unable_connect_\${kind}\`.toUpperCase()
                }
            });`;
const missingStateRenderReplacement = '            return renderManagedOAuthError(res, "missing_state");';
const emptyAuthRenderPoint = `            return res.render('index', {
                data: {
                    error: \`unable_connect_\${kind}\`.toUpperCase()
                }
            });`;
const emptyAuthRenderReplacement = '            return renderManagedOAuthError(res, "unsupported_provider");';

const handlebarsPoint = "h.registerHelper('json', v1 => JSON.stringify(v1)\n    .replace(";
const handlebarsReplacement = "h.registerHelper('json', v1 => (JSON.stringify(v1) ?? 'null')\n    .replace(";

function replaceExact(source, point, replacement, label) {
  if (!source.includes(point)) throw new Error(`The pinned HeyForm ${label} no longer matches the audited OAuth shape.`);
  return source.replace(point, replacement);
}

export function patchSocialLoginService(source) {
  if (source.includes("managedGoogleConfiguration")) throw new Error("The pinned HeyForm service already contains the platform OAuth patch; remove this derived-image patch.");
  source = replaceExact(source, serviceImportPoint, `${serviceImportPoint}\n${serviceHelper}`, "social-login service import");
  source = replaceExact(source, authUrlSignaturePoint, authUrlSignatureReplacement, "social-login authorization signature");
  source = replaceExact(source, googleAuthPoint, googleAuthReplacement, "social-login authorization URL");
  source = replaceExact(source, userInfoSignaturePoint, userInfoSignatureReplacement, "social-login user-info signature");
  source = replaceExact(source, googleUserInfoPoint, googleUserInfoReplacement, "social-login Google identity lookup");
  source = replaceExact(source, authCallbackSignaturePoint, authCallbackSignatureReplacement, "social-login callback signature");
  return replaceExact(source, authCallbackCallPoint, authCallbackCallReplacement, "social-login callback identity call");
}

export function patchSocialLoginController(source) {
  if (source.includes("managedOAuthFailureReason")) throw new Error("The pinned HeyForm controller already contains the platform OAuth patch; remove this derived-image patch.");
  source = replaceExact(source, controllerInsertionPoint, `${controllerInsertionPoint}\n${controllerHelper}`, "social-login controller helper");
  source = replaceExact(source, missingStateRenderPoint, missingStateRenderReplacement, "missing-state render");
  source = replaceExact(source, emptyAuthRenderPoint, emptyAuthRenderReplacement, "empty-auth render");
  source = replaceExact(source, authUrlCallPoint, authUrlCallReplacement, "authorization request origin");
  source = replaceExact(source, callbackStartPoint, callbackStartReplacement, "callback input guard");
  return replaceExact(source, callbackCatchPoint, callbackCatchReplacement, "callback error handler");
}

export function patchHandlebars(source) {
  if (source.includes("JSON.stringify(v1) ?? 'null'")) throw new Error("The pinned HeyForm Handlebars helper already contains the safe JSON patch; remove this derived-image patch.");
  return replaceExact(source, handlebarsPoint, handlebarsReplacement, "Handlebars JSON helper");
}

function main() {
  const [servicePath, controllerPath, handlebarsPath] = process.argv.slice(2);
  if (!servicePath || !controllerPath || !handlebarsPath) throw new Error("Provide the compiled HeyForm social-login service, controller, and Handlebars helper paths.");
  writeFileSync(servicePath, patchSocialLoginService(readFileSync(servicePath, "utf8")));
  writeFileSync(controllerPath, patchSocialLoginController(readFileSync(controllerPath, "utf8")));
  writeFileSync(handlebarsPath, patchHandlebars(readFileSync(handlebarsPath, "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
