ALTER TABLE "app_kv" ALTER COLUMN "value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_kv" ADD COLUMN "value_ciphertext" text;--> statement-breakpoint
ALTER TABLE "app_kv" ADD CONSTRAINT "app_kv_value_storage_check" CHECK ((
        (not "app_kv"."secret" and "app_kv"."value" is not null and "app_kv"."value_ciphertext" is null)
        or
        ("app_kv"."secret" and (("app_kv"."value" is not null) <> ("app_kv"."value_ciphertext" is not null)))
      ));