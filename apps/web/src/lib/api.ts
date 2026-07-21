import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { Auth, TremaClient } from "@trema/server/types";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const link = new RPCLink({
  url: `${globalThis.location?.origin ?? ""}/rpc`,
  fetch: (request, init) => fetch(request, { ...init, credentials: "include" }),
});

export const rpcClient: TremaClient = createORPCClient(link);
export const orpc = createTanstackQueryUtils(rpcClient);

export const authClient = createAuthClient({
  baseURL: globalThis.location?.origin,
  basePath: "/api/auth",
  plugins: [inferAdditionalFields<Auth>()],
});
