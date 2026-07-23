// UI convention: the org scope always renders as "Organization" and personal
// scopes as "Personal"; only shared scopes go by their stored names.
export function scopeDisplayName(scope: { kind: "org" | "shared" | "personal"; name: string }) {
  if (scope.kind === "org") return "Organization";
  if (scope.kind === "personal") return "Personal";
  return scope.name;
}
