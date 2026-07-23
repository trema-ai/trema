export type ProviderHook = (...args: readonly unknown[]) => unknown | Promise<unknown>;
export type ProviderHookRegistry = Readonly<Record<string, ProviderHook>>;

export const providerHookRegistry: ProviderHookRegistry = Object.freeze({});
