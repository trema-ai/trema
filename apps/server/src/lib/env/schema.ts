import { z } from "zod";

const postgresUrl = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "postgres:" || protocol === "postgresql:";
      } catch {
        return false;
      }
    },
    {
      message: "Must be a PostgreSQL URL",
    },
  );

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const url = z.string().trim().url();

const optionalUrl = z.preprocess((value) => (value === "" ? undefined : value), url.optional());

const webOrigins = z
  .string()
  .transform((value) => value.split(",").map((origin) => origin.trim()))
  .pipe(z.array(url).min(1));

const boolean = z.enum(["true", "false"]).transform((value) => value === "true");

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: postgresUrl,
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    TREMA_MODE: z.enum(["hosted", "dedicated"]).default("dedicated"),
    TREMA_AUTH_SECRET: z.string().trim().min(32),
    TREMA_AUTH_BASE_URL: url.default("http://127.0.0.1:3000"),
    TREMA_WEB_ORIGINS: webOrigins.default(["http://127.0.0.1:5173"]),
    TREMA_WEB_DIST: optionalString,
    TREMA_GOOGLE_CLIENT_ID: optionalString,
    TREMA_GOOGLE_CLIENT_SECRET: optionalString,
    TREMA_PASSWORD_AUTH_ENABLED: boolean.default(true),
    TREMA_TERMS_URL: optionalUrl,
    TREMA_PRIVACY_URL: optionalUrl,
    TREMA_BOOTSTRAP_TOKEN: optionalString,
    TREMA_CREDENTIAL_MASTER_KEY: optionalString,
    TREMA_OIDC_ISSUER: optionalString,
    TREMA_OIDC_CLIENT_ID: optionalString,
    TREMA_OIDC_CLIENT_SECRET: optionalString,
  })
  .superRefine((value, context) => {
    const google = [value.TREMA_GOOGLE_CLIENT_ID, value.TREMA_GOOGLE_CLIENT_SECRET];
    if (google.some(Boolean) && !google.every(Boolean)) {
      context.addIssue({
        code: "custom",
        message:
          "TREMA_GOOGLE_CLIENT_ID and TREMA_GOOGLE_CLIENT_SECRET must be configured together",
        path: ["TREMA_GOOGLE_CLIENT_ID"],
      });
    }

    const oidc = [
      value.TREMA_OIDC_ISSUER,
      value.TREMA_OIDC_CLIENT_ID,
      value.TREMA_OIDC_CLIENT_SECRET,
    ];
    if (oidc.some(Boolean) && !oidc.every(Boolean)) {
      context.addIssue({
        code: "custom",
        message:
          "TREMA_OIDC_ISSUER, TREMA_OIDC_CLIENT_ID, and TREMA_OIDC_CLIENT_SECRET must be configured together",
        path: ["TREMA_OIDC_ISSUER"],
      });
    }
  });

export type Environment = Readonly<z.infer<typeof environmentSchema>>;

export function parseEnv(input: Record<string, string | undefined>): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`, {
      cause: result.error,
    });
  }

  return Object.freeze(result.data);
}
