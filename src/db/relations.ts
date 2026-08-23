import { defineRelations } from 'drizzle-orm';
import { authRelations } from './auth-schema';
import * as schema from './schema';

const schemaRelations = defineRelations(schema);

// Better Auth generates a relations part. The complete schema definition must
// come first so every application table remains available through db.query.
export const relations = { ...schemaRelations, ...authRelations };
