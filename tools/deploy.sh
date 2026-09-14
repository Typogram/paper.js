#!/usr/bin/env bash
#
# Build the library, build the landing page and deploy it to Cloudflare Pages.
#
#   ./tools/deploy.sh
#
# The order matters. site/scripts/sync-paper.js copies the *built* bundle from
# dist/, not the sources in src/, and it only fails when dist/ is missing - not
# when it is stale. Building the library first is what keeps a deploy from
# silently shipping the previous renderer.
#
# Cloudflare's own git builds are a separate path; this uploads a directory
# straight to the project and does not go through them. Override the target
# with PROJECT / BRANCH if you are deploying somewhere else:
#
#   PROJECT=paper-js-staging ./tools/deploy.sh
#
set -euo pipefail

PROJECT="${PROJECT:-paper-js}"
BRANCH="${BRANCH:-paperjs-svg-renderer}"

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

echo "==> Building the library from src/"
node tools/build.js

echo "==> Installing site dependencies"
cd site
npm ci

echo "==> Building the landing page"
npm run build

echo "==> Deploying to Cloudflare Pages project '$PROJECT'"
npx wrangler pages deploy build --project-name="$PROJECT" --branch="$BRANCH"
