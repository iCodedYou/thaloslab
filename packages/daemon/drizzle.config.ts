import { defineConfig } from 'drizzle-kit';

// Migration generation is a dev-time step; the generated SQL + meta/_journal.json under
// ./migrations are committed and applied at daemon boot (src/store/migrate.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/schema.ts',
  out: './migrations',
});
