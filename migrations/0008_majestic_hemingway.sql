-- This deployment only supports credential accounts, whose issuer is fixed.
-- The temporary default backfills existing rows without changing account_id.
ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL DEFAULT 'local:credential';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");
