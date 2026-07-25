import { env } from "#server/lib/env/index.js";
import { serveTrema } from "#server/server.js";

const { app } = await serveTrema({ env });

export { app };
