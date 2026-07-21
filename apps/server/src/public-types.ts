export type { Auth } from "./lib/auth/index.js";
export type { Router } from "./router.js";

import type { RouterClient } from "@orpc/server";
import type { Router } from "./router.js";
export type TremaClient = RouterClient<Router>;
