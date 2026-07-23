import { z } from "zod";

export const fieldDescriptorSchema = z
  .object({
    type: z.literal("string"),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    example: z.string().optional(),
    pattern: z.string().min(1).optional(),
    optional: z.boolean().optional(),
    secret: z.boolean().optional(),
    enum: z.array(z.string()).min(1).optional(),
    default: z.string().optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    visibleWhen: z
      .object({ field: z.string().trim().min(1), equals: z.string() })
      .strict()
      .optional(),
    automated: z.boolean().optional(),
  })
  .strict();

export const authModes = [
  "oauth2_code",
  "oauth2_client_credentials",
  "api_key",
  "basic",
  "jwt_signed",
  "two_step",
  "mcp_oauth",
] as const;

export const authModeSchema = z.enum(authModes);

export const authRecipeSchema = z
  .object({
    authorizationUrl: z.string().trim().min(1).optional(),
    tokenUrl: z.string().trim().min(1).optional(),
    refreshUrl: z.string().trim().min(1).optional(),
    defaultScopes: z.array(z.string().trim().min(1)),
    scopeSeparator: z.string().min(1).optional(),
    pkce: z.boolean().default(true),
    tokenRequestAuthMethod: z.enum(["basic", "body", "private_key_jwt"]).optional(),
    tokenResponseMetadata: z.array(z.string().trim().min(1)).optional(),
    tokenExpirationBuffer: z.number().int().nonnegative().optional(),
  })
  .strict();

const retrySchema = z
  .object({
    afterHeaders: z.array(z.string().trim().min(1)).min(1).optional(),
    atHeaders: z.array(z.string().trim().min(1)).min(1).optional(),
    remainingHeader: z.string().trim().min(1).optional(),
    bodyPath: z.string().trim().min(1).optional(),
  })
  .strict();

const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const verificationSchema = z
  .object({
    method: httpMethodSchema,
    endpoints: z.array(z.string().trim().min(1)).min(1),
    // JSON request body for providers whose cheap check is not a bare GET
    // (e.g. a GraphQL endpoint that rejects an empty POST).
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((verification) => verification.body === undefined || verification.method === "POST", {
    message: "verification body requires method POST",
  });

export const restTransportSchema = z
  .object({
    type: z.literal("rest"),
    baseUrl: z.string().trim().min(1),
    authHeader: z.string().min(1).optional(),
    retry: retrySchema.optional(),
    verification: verificationSchema.optional(),
  })
  .strict();

export const mcpTransportSchema = z
  .object({
    type: z.literal("mcp"),
    serverUrl: z.string().trim().min(1),
  })
  .strict();

export const transportSchema = z.discriminatedUnion("type", [
  restTransportSchema,
  mcpTransportSchema,
]);

export const toolDefinitionSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    method: httpMethodSchema,
    path: z.string().trim().min(1),
    paramsSchema: z.record(z.string(), z.unknown()),
    authInjection: z.record(z.string(), z.unknown()).optional(),
    sensitivity: z.enum(["read", "write", "destructive"]),
  })
  .strict();

const webhooksSchema = z
  .object({
    routingKey: z.string().trim().min(1),
    secretField: z.string().trim().min(1).optional(),
    allowedQueryParams: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export const providerHooksSchema = z
  .object({
    postConnection: z.string().trim().min(1).optional(),
    credentialsVerification: z.string().trim().min(1).optional(),
  })
  .strict();

export const providerDefSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
    displayName: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    logoUrl: z.string().trim().min(1).optional(),
    categories: z.array(z.string().trim().min(1)).min(1),
    docsUrl: z.url(),
    authMode: authModeSchema,
    auth: authRecipeSchema,
    configFields: z.record(z.string().min(1), fieldDescriptorSchema),
    credentialFields: z.record(z.string().min(1), fieldDescriptorSchema),
    transport: transportSchema,
    webhooks: webhooksSchema.optional(),
    toolManifest: z.array(toolDefinitionSchema).default([]),
    memberConnectable: z.boolean().default(false),
    hooks: providerHooksSchema.optional(),
  })
  .strict()
  .superRefine((provider, context) => {
    if (provider.authMode === "oauth2_code") {
      if (!provider.auth.authorizationUrl) {
        context.addIssue({
          code: "custom",
          message: "oauth2_code requires authorizationUrl",
          path: ["auth", "authorizationUrl"],
        });
      }
      if (!provider.auth.tokenUrl) {
        context.addIssue({
          code: "custom",
          message: "oauth2_code requires tokenUrl",
          path: ["auth", "tokenUrl"],
        });
      }
    }

    if (provider.authMode === "oauth2_client_credentials" && !provider.auth.tokenUrl) {
      context.addIssue({
        code: "custom",
        message: "oauth2_client_credentials requires tokenUrl",
        path: ["auth", "tokenUrl"],
      });
    }

    if (provider.authMode === "api_key" || provider.authMode === "basic") {
      for (const field of ["authorizationUrl", "tokenUrl", "refreshUrl"] as const) {
        if (provider.auth[field]) {
          context.addIssue({
            code: "custom",
            message: `${provider.authMode} does not accept ${field}`,
            path: ["auth", field],
          });
        }
      }
    }

    if (provider.transport.type === "rest" && provider.toolManifest.length === 0) {
      context.addIssue({
        code: "custom",
        message: "REST providers require a non-empty toolManifest",
        path: ["toolManifest"],
      });
    }
  });

export type FieldDescriptor = z.infer<typeof fieldDescriptorSchema>;
export type AuthMode = z.infer<typeof authModeSchema>;
export type AuthRecipe = z.infer<typeof authRecipeSchema>;
export type RestTransport = z.infer<typeof restTransportSchema>;
export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type ProviderTransport = z.infer<typeof transportSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ProviderHooks = z.infer<typeof providerHooksSchema>;
export type ProviderDef = z.infer<typeof providerDefSchema>;
export type ProviderDefInput = z.input<typeof providerDefSchema>;
