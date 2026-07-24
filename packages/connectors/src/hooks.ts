export interface PostConnectionHookInput {
  // The complete token response is intentionally available only to in-repo
  // hooks. Hooks must return account metadata, never credentials or tokens.
  tokenResponse: Readonly<Record<string, unknown>>;
  config: Readonly<Record<string, unknown>>;
}

export type PostConnectionHook = (
  input: PostConnectionHookInput,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

// Provider hooks are named escape hatches resolved from reviewed, in-repo
// code. Catalog data can choose a hook but cannot supply executable code.
export type ProviderHook = PostConnectionHook;
export type ProviderHookRegistry = Readonly<Record<string, ProviderHook>>;

function stringClaim(claims: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const googleIdTokenIdentity: PostConnectionHook = ({ tokenResponse }) => {
  const idToken = tokenResponse.id_token;
  if (typeof idToken !== "string") return {};

  const segments = idToken.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || !payload) return {};

  try {
    // The id_token arrived directly over TLS from Google's token endpoint, so
    // this hook decodes its payload without signature verification.
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return {};
    const claims = decoded as Record<string, unknown>;
    return Object.fromEntries(
      ["sub", "email", "hd"].flatMap((name) => {
        const value = stringClaim(claims, name);
        return value === undefined ? [] : [[name, value]];
      }),
    );
  } catch {
    return {};
  }
};

export const providerHookRegistry: ProviderHookRegistry = Object.freeze({
  google_id_token_identity: googleIdTokenIdentity,
});
