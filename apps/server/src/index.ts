import { env } from "#/lib/env/index.js";
import { serveTrema } from "#/server.js";

const { app } = await serveTrema({ env });

export { app };
