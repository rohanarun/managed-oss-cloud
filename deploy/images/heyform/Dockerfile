FROM heyform/community-edition:v3.0.1@sha256:d74d6605ed8bd3dcf3681dbfe9e39d4c5a2d67de87fd2f3964bf9460aeede911

COPY patch-runtime-config.mjs patch-platform-oauth.mjs /tmp/
RUN node /tmp/patch-runtime-config.mjs /app/packages/server/dist/src/controller/dashboard.controller.js \
  && node /tmp/patch-platform-oauth.mjs \
    /app/packages/server/dist/src/service/social-login.service.js \
    /app/packages/server/dist/src/controller/social-login.controller.js \
    /app/packages/server/dist/src/utils/handlebars.js \
  && rm /tmp/patch-runtime-config.mjs /tmp/patch-platform-oauth.mjs

LABEL org.opencontainers.image.source="https://github.com/rohanarun/managed-oss-cloud/tree/main/deploy/images/heyform" \
  org.opencontainers.image.licenses="AGPL-3.0-only" \
  org.opencontainers.image.base.name="docker.io/heyform/community-edition:v3.0.1" \
  org.opencontainers.image.base.digest="sha256:d74d6605ed8bd3dcf3681dbfe9e39d4c5a2d67de87fd2f3964bf9460aeede911" \
  io.getsupers.managed-oss.upstream.source="https://github.com/heyform/heyform/tree/v3.0.1" \
  io.getsupers.managed-oss.upstream.license="https://github.com/heyform/heyform/blob/v3.0.1/LICENSE" \
  org.opencontainers.image.description="AGPL-3.0-only HeyForm Community Edition derivative with hosting-layer Google OAuth support"
