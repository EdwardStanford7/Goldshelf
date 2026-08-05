D1_NAME = media-rating
R2_BUCKET = media-rating-images

.PHONY: help bootstrap-help install dev preview test e2e typecheck audit audit-fix build check \
	wrangler-auth migrate-local migrate-remote cf-migrate-local cf-migrate-remote \
	password-reset-link password-reset-link-local \
	admin-promote admin-promote-local admin-demote admin-demote-local \
	auth-clear-rate-limits auth-clear-rate-limits-local \
	cf-login cf-whoami cf-create-d1 cf-create-r2 cf-secret-auth cf-secret-password-reset \
	verify-deploy-config deploy deploy-first

help:
	@echo "Goldshelf web commands"
	@echo ""
	@echo "Daily:"
	@echo "  make install              Install pnpm dependencies from the lockfile"
	@echo "  make dev                  Start local dev server"
	@echo "  make check                Run tests, typecheck, e2e, audit, and build"
	@echo "  make deploy               Check, migrate remote D1, then deploy"
	@echo "  make audit-fix            Refresh dependency resolution and rerun audit"
	@echo ""
	@echo "Checks:"
	@echo "  make test                 Run Vitest unit tests"
	@echo "  make e2e                  Run Playwright browser tests"
	@echo "  make typecheck            Generate routes and run TypeScript checks"
	@echo "  make audit                Run production dependency audit"
	@echo "  make build                Build the Worker bundle"
	@echo ""
	@echo "Database:"
	@echo "  make migrate-local        Apply D1 migrations to local Wrangler D1"
	@echo "  make migrate-remote       Log in if needed, then apply remote D1 migrations"
	@echo ""
	@echo "Ops / recovery:"
	@echo "  make password-reset-link EMAIL=user@example.com Generate a one-hour remote reset link"
	@echo "  make password-reset-link-local EMAIL=user@example.com Generate a local D1 reset link"
	@echo "  make admin-promote EMAIL=user@example.com Promote a remote user to admin"
	@echo "  make admin-promote-local EMAIL=user@example.com Promote a local user to admin"
	@echo "  make admin-demote EMAIL=user@example.com Demote a remote admin user"
	@echo "  make admin-demote-local EMAIL=user@example.com Demote a local admin user"
	@echo "  make auth-clear-rate-limits Clear remote auth rate-limit lockouts"
	@echo "  make auth-clear-rate-limits-local Clear local auth rate-limit lockouts"
	@echo ""
	@echo "Rare setup:"
	@echo "  make bootstrap-help       Show one-time Cloudflare setup targets"

bootstrap-help:
	@echo "One-time / rare Cloudflare setup"
	@echo ""
	@echo "  make cf-login             Authenticate Wrangler manually"
	@echo "  make cf-whoami            Show current Wrangler account"
	@echo "  make cf-create-d1         Create D1 database and update wrangler.jsonc"
	@echo "  make cf-create-r2         Create R2 bucket and update wrangler.jsonc"
	@echo "  make cf-secret-auth       Generate and set BETTER_AUTH_SECRET"
	@echo "  make cf-secret-password-reset Set Resend password reset email secrets"
	@echo "  make deploy-first         Run first-time Cloudflare setup sequence"
	@echo ""
	@echo "You normally only need these for a new Cloudflare project, deleted/recreated resources,"
	@echo "or intentional secret/resource rotation."

install:
	pnpm install --frozen-lockfile

dev:
	pnpm dev

preview:
	pnpm preview

test:
	pnpm test

e2e:
	pnpm test:e2e

typecheck:
	pnpm typecheck

audit:
	node scripts/audit-prod.mjs

audit-fix:
	pnpm install --no-frozen-lockfile
	$(MAKE) audit

build:
	pnpm build

check:
	$(MAKE) test
	$(MAKE) typecheck
	$(MAKE) e2e
	$(MAKE) audit
	$(MAKE) build

wrangler-auth:
	@pnpm exec wrangler whoami >/dev/null 2>&1 || (echo "Wrangler session missing or expired; opening login..." && pnpm exec wrangler login)

migrate-local:
	pnpm db:migrate:local

migrate-remote:
	$(MAKE) wrangler-auth
	pnpm db:migrate:remote

cf-migrate-local: migrate-local

cf-migrate-remote: migrate-remote

password-reset-link:
	@test -n "$(EMAIL)" || (echo "Usage: make password-reset-link EMAIL=user@example.com"; exit 1)
	$(MAKE) wrangler-auth
	node scripts/create-password-reset-link.mjs "$(EMAIL)"

password-reset-link-local:
	@test -n "$(EMAIL)" || (echo "Usage: make password-reset-link-local EMAIL=user@example.com"; exit 1)
	node scripts/create-password-reset-link.mjs "$(EMAIL)" http://localhost:5173 --local

admin-promote:
	@test -n "$(EMAIL)" || (echo "Usage: make admin-promote EMAIL=user@example.com"; exit 1)
	$(MAKE) wrangler-auth
	node scripts/admin-role.mjs promote "$(EMAIL)"

admin-promote-local:
	@test -n "$(EMAIL)" || (echo "Usage: make admin-promote-local EMAIL=user@example.com"; exit 1)
	node scripts/admin-role.mjs promote "$(EMAIL)" --local

admin-demote:
	@test -n "$(EMAIL)" || (echo "Usage: make admin-demote EMAIL=user@example.com"; exit 1)
	$(MAKE) wrangler-auth
	node scripts/admin-role.mjs demote "$(EMAIL)"

admin-demote-local:
	@test -n "$(EMAIL)" || (echo "Usage: make admin-demote-local EMAIL=user@example.com"; exit 1)
	node scripts/admin-role.mjs demote "$(EMAIL)" --local

auth-clear-rate-limits:
	$(MAKE) wrangler-auth
	node scripts/clear-auth-rate-limits.mjs

auth-clear-rate-limits-local:
	node scripts/clear-auth-rate-limits.mjs --local

cf-login:
	pnpm exec wrangler login

cf-whoami:
	pnpm exec wrangler whoami

cf-create-d1:
	node scripts/create-d1-if-needed.mjs $(D1_NAME)

cf-create-r2:
	@echo "If this fails with Cloudflare code 10042, enable R2 in the Cloudflare dashboard first."
	node scripts/create-r2-if-needed.mjs $(R2_BUCKET)

cf-secret-auth:
	openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET

cf-secret-password-reset:
	@echo "Set these after creating a Resend API key and verifying send.goldshelf.net."
	@echo "Use PASSWORD_RESET_FROM_EMAIL value: goldshelf <reset@send.goldshelf.net>"
	pnpm exec wrangler secret put RESEND_API_KEY
	pnpm exec wrangler secret put PASSWORD_RESET_FROM_EMAIL

verify-deploy-config:
	node scripts/verify-deploy-config.mjs

deploy: verify-deploy-config
	$(MAKE) check
	$(MAKE) migrate-remote
	pnpm run deploy

deploy-first: install cf-login cf-create-d1 cf-create-r2 cf-secret-auth
	@echo ""
	@echo "Before running make deploy:"
	@echo "1. Confirm goldshelf.net is active in Cloudflare and has no conflicting apex DNS record."
	@echo "2. Run make cf-secret-auth again after the Worker rename, then make cf-secret-password-reset after Resend is ready."
	@echo "3. Run make deploy."
