export {
  loadProviderCatalog,
  type ProviderCatalog,
  ProviderCatalogValidationError,
} from "#connectors/catalog.js";
export {
  googleIdTokenIdentity,
  type PostConnectionHook,
  type PostConnectionHookInput,
  type ProviderHook,
  type ProviderHookRegistry,
  providerHookRegistry,
} from "#connectors/hooks.js";
export {
  type ListedOperation,
  listOperations,
  type ManifestConversion,
  type ManifestCuration,
  type ManifestCurationInput,
  manifestCurationSchema,
  OpenApiConversionError,
  type OpenApiDocument,
  openApiSpecToToolManifest,
  parseOpenApiDocument,
} from "#connectors/openapi/index.js";
export * from "#connectors/providers/index.js";
export {
  type AuthMode,
  type AuthRecipe,
  authModeSchema,
  authModes,
  authRecipeSchema,
  type FieldDescriptor,
  fieldDescriptorSchema,
  type McpTransport,
  mcpTransportSchema,
  type ProviderDef,
  type ProviderDefInput,
  type ProviderHooks,
  type ProviderTransport,
  providerDefSchema,
  providerHooksSchema,
  type RestTransport,
  restTransportSchema,
  type ToolDefinition,
  toolDefinitionSchema,
  transportSchema,
} from "#connectors/schema.js";
export {
  extractPlaceholders,
  interpolate,
  TemplateInterpolationError,
  type TemplateValues,
} from "#connectors/templates.js";
