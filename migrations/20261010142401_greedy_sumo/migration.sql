CREATE TABLE "apikey" (
	"id" text PRIMARY KEY,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp,
	"polling_interval" integer,
	"client_id" text,
	"scope" text,
	"hatch_resources" text NOT NULL,
	"hatch_expires_in" integer NOT NULL,
	"hatch_instance_id" text NOT NULL,
	"hatch_instance_epoch" integer NOT NULL,
	"hatch_session_id" text,
	"hatch_user_epoch" integer
);
--> statement-breakpoint
CREATE TABLE "cli_auth_audit" (
	"id" text PRIMARY KEY,
	"action" text NOT NULL,
	"user_id" text,
	"credential_id" text,
	"run_id" text,
	"details" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_auth_instance" (
	"id" text PRIMARY KEY,
	"instance_id" text NOT NULL UNIQUE,
	"epoch" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cli_auth_single_instance" CHECK ("id" = 'platform')
);
--> statement-breakpoint
CREATE TABLE "cli_credential_bindings" (
	"key_id" text PRIMARY KEY,
	"credential_type" text NOT NULL,
	"user_id" text NOT NULL,
	"user_epoch" integer NOT NULL,
	"instance_id" text NOT NULL,
	"instance_epoch" integer NOT NULL,
	"resources" jsonb NOT NULL,
	"display_name" text NOT NULL,
	"issued_expires_at" timestamp with time zone NOT NULL,
	"run_id" text,
	"session_id" text,
	"runner_id" text,
	"run_epoch" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "cli_binding_context" CHECK (("credential_type" IN ('interactive_key', 'user_api_key') AND "run_id" IS NULL AND "session_id" IS NULL AND "runner_id" IS NULL AND "run_epoch" IS NULL) OR ("credential_type" = 'run_key' AND "run_id" IS NOT NULL AND "session_id" IS NOT NULL AND "runner_id" IS NOT NULL AND "run_epoch" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cli_run_authorizations" (
	"run_id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_epoch" integer NOT NULL,
	"instance_id" text NOT NULL,
	"instance_epoch" integer NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"scopes" jsonb NOT NULL,
	"resources" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_user_security" (
	"user_id" text PRIMARY KEY,
	"epoch" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" ("user_code");--> statement-breakpoint
CREATE INDEX "cli_audit_user_time_idx" ON "cli_auth_audit" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "cli_bindings_user_idx" ON "cli_credential_bindings" ("user_id");--> statement-breakpoint
CREATE INDEX "cli_bindings_run_idx" ON "cli_credential_bindings" ("run_id");--> statement-breakpoint
CREATE INDEX "cli_run_auth_user_idx" ON "cli_run_authorizations" ("user_id");--> statement-breakpoint
-- Stable installation identity and historical user epochs; never infer Run issuers.
INSERT INTO cli_auth_instance (id, instance_id) VALUES ('platform', gen_random_uuid()::text) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO cli_user_security (user_id) SELECT id FROM "user" ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION hatch_cli_password_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE uid text;
BEGIN
  uid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  IF (TG_OP = 'UPDATE' AND OLD.password IS NOT DISTINCT FROM NEW.password) OR
     (TG_OP = 'INSERT' AND NEW.password IS NULL) OR
     (TG_OP = 'DELETE' AND OLD.password IS NULL) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  INSERT INTO cli_user_security (user_id, epoch) VALUES (uid, 2)
    ON CONFLICT (user_id) DO UPDATE SET epoch = cli_user_security.epoch + 1;
  INSERT INTO cli_auth_audit (id, action, user_id, details)
    VALUES (gen_random_uuid()::text, 'user.password.invalidate', uid, '{}');
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE TRIGGER hatch_cli_password_epoch AFTER INSERT OR UPDATE OF password OR DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION hatch_cli_password_epoch();
--> statement-breakpoint
CREATE FUNCTION hatch_cli_user_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cli_user_security (user_id, epoch) VALUES (OLD.id, 2)
    ON CONFLICT (user_id) DO UPDATE SET epoch = cli_user_security.epoch + 1;
  INSERT INTO cli_auth_audit (id, action, user_id, details)
    VALUES (gen_random_uuid()::text, 'user.delete.invalidate', OLD.id, '{}');
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER hatch_cli_user_deleted BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION hatch_cli_user_deleted();
--> statement-breakpoint
CREATE FUNCTION hatch_cli_run_ended() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.status NOT IN ('running', 'blocked') OR
     (OLD.runner_id IS NOT NULL AND OLD.runner_id IS DISTINCT FROM NEW.runner_id) OR
     (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at <= clock_timestamp() AND NEW.lease_expires_at > OLD.lease_expires_at) THEN
    UPDATE cli_run_authorizations SET revoked_at = clock_timestamp(), epoch = epoch + 1
      WHERE run_id = OLD.id AND revoked_at IS NULL;
    IF FOUND THEN
      INSERT INTO cli_auth_audit (id, action, run_id, details)
        VALUES (gen_random_uuid()::text, 'run.invalidate', OLD.id, '{}');
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE TRIGGER hatch_cli_run_ended BEFORE UPDATE OF status, runner_id, lease_expires_at OR DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION hatch_cli_run_ended();
--> statement-breakpoint
CREATE FUNCTION hatch_cli_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'cli_auth_audit is append-only'; END $$;
--> statement-breakpoint
CREATE TRIGGER hatch_cli_audit_immutable BEFORE UPDATE OR DELETE ON cli_auth_audit
  FOR EACH ROW EXECUTE FUNCTION hatch_cli_audit_immutable();
