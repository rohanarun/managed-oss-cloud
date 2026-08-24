import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { patchHandlebars, patchSocialLoginController, patchSocialLoginService } from "../deploy/images/heyform/patch-platform-oauth.mjs";
import { patchRuntimeConfig } from "../deploy/images/heyform/patch-runtime-config.mjs";

const serviceFixture = `"use strict";
const shared_types_enums_1 = require("@heyform-inc/shared-types-enums");
const common_1 = require("@nestjs/common");
const _environments_1 = require("../environments");
const _utils_1 = require("../utils");
class SocialLoginService {
    static callbackUrl(kind) {
        return \`${"${_environments_1.APP_HOMEPAGE_URL}"}/connect/${"${kind}"}/callback\`;
    }
    authUrl(kind, state) {
        const redirectUrl = "callback";
        switch (kind) {
            case shared_types_enums_1.SocialLoginTypeEnum.GOOGLE:
                return (0, _utils_1.googleLoginUrl)(Object.assign(Object.assign({}, googleOptions), { redirectUrl,
                    state }));
        }
    }
    async userInfo(kind, code) {
        const redirectUrl = "callback";
        switch (kind) {
            case shared_types_enums_1.SocialLoginTypeEnum.GOOGLE:
                return await (0, _utils_1.googleUserInfo)(code, Object.assign(Object.assign({}, googleOptions), { redirectUrl }));
        }
    }
    async authCallback(kind, code) {
        const userInfo = await this.userInfo(kind, code);
        return userInfo.openId;
    }
}`;

const controllerFixture = `"use strict";
const shared_types_enums_1 = require("@heyform-inc/shared-types-enums");
const common_1 = require("@nestjs/common");
const utils_1 = require("@heyform-inc/utils");
const OAUTH_STATE_TTL = '10m';
class SocialLoginController {
    async authUrl(kind, query, req, res) {
        if (utils_1.helper.isEmpty(query.state)) {
            return res.render('index', {
                payload: {
                    error: \`unable_connect_${"${kind}"}\`.toUpperCase()
                }
            });
        }
        const oauthState = await this.authService.createOAuthState(req, res, query.state);
        const authUrl = this.socialLoginService.authUrl(kind, oauthState);
        if (utils_1.helper.isEmpty(authUrl)) {
            return res.render('index', {
                data: {
                    error: \`unable_connect_${"${kind}"}\`.toUpperCase()
                }
            });
        }
    }
    async handleCallback(kind, query, req, res) {
        try {
            await this.authService.verifyOAuthState(req, res, query.state);
            const userId = await this.socialLoginService.authCallback(kind, query.code || query.credential);
            return userId;
        }
        catch (err) {
            this.logger.error(err);
            res.render('index', {
                data: {
                    error: \`unable_connect_${"${kind}"}\`.toUpperCase()
                }
            });
        }
    }
}`;

const handlebarsFixture = `"use strict";
const h = require("hbs");
h.registerHelper('json', v1 => JSON.stringify(v1)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e'));
`;

describe("pinned HeyForm platform OAuth image patch", () => {
  it("wires all three audited compiled files into the derived image build", () => {
    const dockerfile = readFileSync(new URL("../deploy/images/heyform/Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain("/app/packages/server/dist/src/service/social-login.service.js");
    expect(dockerfile).toContain("/app/packages/server/dist/src/controller/social-login.controller.js");
    expect(dockerfile).toContain("/app/packages/server/dist/src/utils/handlebars.js");
  });

  it("routes authorization through the broker and verifies audience, state binding, lifetime, and Ed25519 assertions locally", () => {
    const patched = patchSocialLoginService(serviceFixture);
    expect(() => new Function(patched)).not.toThrow();
    expect(patched).toContain('start.pathname !== "/oauth/google/start"');
    expect(patched).toContain('origin.protocol !== "https:"');
    expect(patched).toContain('publicKey.asymmetricKeyType !== "ed25519"');
    expect(patched).toContain('target.searchParams.set("application_id", configuration.applicationId)');
    expect(patched).toContain('managedGoogleAuthUrl(state, requestOrigin)');
    expect(patched).toContain('payload.aud === configuration.origin');
    expect(patched).toContain('payload.state_hash === expectedStateHash');
    expect(patched).toContain('payload.exp - payload.iat === 90');
    expect(patched).toContain('managed_oauth_crypto_1.verify');
    expect(patched).toContain('["en", "pt-br", "zh-cn"].includes(assertedLocale) ? assertedLocale : "en"');
    expect(patched).not.toMatch(/CLIENT_SECRET|STATE_SECRET|SIGNING_PRIVATE/);
    expect(() => patchSocialLoginService(patched)).toThrow(/already contains/);
  });

  it("consumes the app state before accepting an assertion and emits only redacted diagnostics plus a safe retry page", () => {
    const patched = patchSocialLoginController(controllerFixture);
    expect(() => new Function(patched)).not.toThrow();
    const verification = patched.indexOf('verifyOAuthState(req, res, query.state)');
    expect(verification).toBeGreaterThan(0);
    expect(verification).toBeLessThan(patched.indexOf('utils_1.helper.isEmpty(query.assertion)', verification));
    expect(patched).toContain('reason=${reason} state_present=${Boolean(query && query.state)} assertion_present=${Boolean(query && query.assertion)}');
    expect(patched).toContain('error_type=${errorType}');
    expect(patched).toContain('res.set("Cache-Control", "no-store")');
    expect(patched).toContain('No account session was created. Return to sign in and try again.');
    expect(patched).toContain('authCallback(kind, credential, query.state, managedOAuthRequestOrigin(req))');
    expect(patched).toContain('managedOAuthRequestOrigin(req)');
    expect(patched).not.toContain("res.render('index'");
    expect(patched).not.toContain("this.logger.error(err)");
    expect(() => patchSocialLoginController(patched)).toThrow(/already contains/);
  });

  it("shows Google sign-in only when every public broker setting is present", () => {
    const source = `            enableGoogleFonts: _environments_1.ENABLE_GOOGLE_FONTS,`;
    const patched = patchRuntimeConfig(source);
    expect(patched).toContain("MANAGED_GOOGLE_BROKER_START_URL");
    expect(patched).toContain("MANAGED_OAUTH_ASSERTION_PUBLIC_KEY");
    expect(patched).toContain("MANAGED_OAUTH_APPLICATION_ID");
    expect(patched).not.toMatch(/CLIENT_SECRET|STATE_SECRET|SIGNING_PRIVATE/);
    expect(() => patchRuntimeConfig(patched)).toThrow(/already contains/);
  });

  it("makes undefined template JSON safe and rejects an unrecognized pinned-image shape", () => {
    const patched = patchHandlebars(handlebarsFixture);
    expect(() => new Function(patched)).not.toThrow();
    expect(patched).toContain("JSON.stringify(v1) ?? 'null'");
    expect(() => patchHandlebars(patched)).toThrow(/already contains/);
    expect(() => patchSocialLoginController("upstream changed")).toThrow(/no longer matches/);
  });
});
