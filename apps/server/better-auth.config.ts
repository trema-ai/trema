import { createAuth } from "./src/lib/auth/index.js";
import { createPrismaClient } from "./src/lib/db/index.js";
import { env } from "./src/lib/env/index.js";

export const auth = createAuth({
  db: createPrismaClient(env.DATABASE_URL),
  env,
});
