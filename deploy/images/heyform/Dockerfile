FROM heyform/community-edition:v3.0.1@sha256:d74d6605ed8bd3dcf3681dbfe9e39d4c5a2d67de87fd2f3964bf9460aeede911

COPY patch-runtime-config.mjs patch-platform-oauth.mjs /tmp/
RUN node /tmp/patch-runtime-config.mjs /app/packages/server/dist/src/controller/dashboard.controller.js \
  && node /tmp/patch-platform-oauth.mjs /app/packages/server/dist/src/service/social-login.service.js \
  && rm /tmp/patch-runtime-config.mjs /tmp/patch-platform-oauth.mjs

LABEL org.opencontainers.image.source="https://github.com/rohanarun/managed-oss-cloud" \
  org.opencontainers.image.description="Pinned HeyForm Community Edition with hosting-layer Google OAuth support"
