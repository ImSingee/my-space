/** Trusted Connect codegen configuration shared by App preparation and deploy. */
export const PLATFORM_APP_BUF_GEN_YAML = `version: v2
clean: true
plugins:
  - local: protoc-gen-es
    out: gen
    opt:
      - target=ts
      - import_extension=ts
`;
