import "dotenv/config";

import { parseEnv } from "./schema.js";

export const env = parseEnv(process.env);

export type { Environment } from "./schema.js";
