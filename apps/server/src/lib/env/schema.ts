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

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: postgresUrl,
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type Environment = Readonly<z.infer<typeof environmentSchema>>;

export function parseEnv(
  input: Record<string, string | undefined>,
): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }

  return Object.freeze(result.data);
}
