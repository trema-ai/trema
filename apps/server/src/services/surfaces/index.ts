export const surfaceCatalog = [
  // The service endpoint scripts and internal systems call. Its locations bind
  // to scopes exactly as a chat surface's do.
  { id: "api", name: "API", status: "available" },
  { id: "slack", name: "Slack", status: "planned" },
  { id: "linear", name: "Linear", status: "planned" },
  { id: "github", name: "GitHub", status: "planned" },
  { id: "email", name: "Email", status: "planned" },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  status: "planned" | "available";
}>;

export type SurfaceId = (typeof surfaceCatalog)[number]["id"];

const knownSurfaceIds = new Set<string>(surfaceCatalog.map(({ id }) => id));

// Availability will derive from installed integrations in a later phase.
export function isKnownSurface(surface: string): surface is SurfaceId {
  return knownSurfaceIds.has(surface);
}
