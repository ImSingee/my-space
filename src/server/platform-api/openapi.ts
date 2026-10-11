import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { platformApiContract } from '~/platform-api/contract';

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});
let spec: ReturnType<typeof generator.generate> | undefined;

export function generatePlatformOpenApi() {
  return (spec ??= generator.generate(platformApiContract, {
    info: { title: 'Hatch Platform API', version: '1.0.0' },
    servers: [{ url: '/api/v1' }],
    security: [{ sessionCookie: [] }, { bearer: [] }, { apiKey: [] }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description:
            'Better Auth session cookie (secure production cookies use the __Secure- prefix).',
        },
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Better Auth session token or Agent Run JWT. Each valid credential grants full public API access.',
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'User API key with full public API access.',
        },
      },
    },
  }));
}
