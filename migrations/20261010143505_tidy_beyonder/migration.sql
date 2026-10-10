CREATE TABLE "cli_auth_limits" (
	"bucket" text PRIMARY KEY,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
