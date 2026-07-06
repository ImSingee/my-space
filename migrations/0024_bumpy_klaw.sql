CREATE TABLE "platform_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Upgrade seed: installs that already have an account predate this setting
-- and ran with sign-up closed in production (the removed HATCH_ALLOW_SIGNUP
-- gate). Without a row they would fall back to the fresh-install default
-- (open) and silently reopen registration, so seed the closed state; owners
-- can re-open it in Settings -> Users. Fresh installs (no users yet) get no
-- row and stay open for bootstrapping the first account.
INSERT INTO "platform_config" ("key", "value")
SELECT 'auth.allowSignup', 'false'::jsonb
WHERE EXISTS (SELECT 1 FROM "user")
ON CONFLICT ("key") DO NOTHING;
