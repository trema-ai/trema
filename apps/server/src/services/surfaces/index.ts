export const surfaceCatalog = [
  // The web app's own chat. Built in and the one surface with no bindable
  // locations: a member has exactly one web location — their chat with the
  // agent — and it resolves implicitly to their personal scope.
  { id: "web", name: "Web", status: "available", builtIn: true, locationBindable: false },
  // The service endpoint scripts and internal systems call. Its locations bind
  // to scopes exactly as a chat surface's do.
  { id: "api", name: "API", status: "available", builtIn: true, locationBindable: true },
  { id: "slack", name: "Slack", status: "planned", builtIn: false, locationBindable: true },
  { id: "linear", name: "Linear", status: "planned", builtIn: false, locationBindable: true },
  { id: "github", name: "GitHub", status: "planned", builtIn: false, locationBindable: true },
  { id: "email", name: "Email", status: "planned", builtIn: false, locationBindable: true },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  status: "planned" | "available";
  /** Ships with the deployment rather than arriving with an installed integration. */
  builtIn: boolean;
  /**
   * Whether an admin can bind one of this surface's locations to a scope. A
   * surface that is not location-bindable resolves implicitly instead — there
   * is nothing for an admin to pick and no entry in the binding UI.
   */
  locationBindable: boolean;
}>;

export type SurfaceId = (typeof surfaceCatalog)[number]["id"];
export type Surface = (typeof surfaceCatalog)[number];

const surfacesById = new Map<string, Surface>(
  surfaceCatalog.map((surface) => [surface.id, surface]),
);

// Availability will derive from installed integrations in a later phase.
export function isKnownSurface(surface: string): surface is SurfaceId {
  return surfacesById.has(surface);
}

export function getSurface(surface: string): Surface | undefined {
  return surfacesById.get(surface);
}

/** Unknown surfaces are not bindable either; `createBinding` reports that first. */
export function isLocationBindable(surface: string): boolean {
  return surfacesById.get(surface)?.locationBindable ?? false;
}

export {
  type CommitRealizationInput,
  PrismaSurfaceRealizationStore,
  type RecordRenderFailureInput,
  type StageRenderPlanInput,
  SurfaceRealizationConflictError,
  type SurfaceRealizationStoreOptions,
} from "#server/services/surfaces/store.js";
