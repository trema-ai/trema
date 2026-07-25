import { type FormEvent, type ReactNode, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { AuthLayout, OrDivider } from "#web/components/trema/auth-layout.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import { authClient } from "#web/lib/api.ts";

type Providers = { password: boolean; google: boolean };
type Legal = { termsUrl: string | null; privacyUrl: string | null };

function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </a>
  );
}

function LegalFooter({ legal }: { legal: Legal }) {
  if (!legal.termsUrl && !legal.privacyUrl) return null;
  const links = [
    legal.termsUrl && (
      <LegalLink key="terms" href={legal.termsUrl}>
        Terms of Service
      </LegalLink>
    ),
    legal.privacyUrl && (
      <LegalLink key="privacy" href={legal.privacyUrl}>
        Privacy Policy
      </LegalLink>
    ),
  ].filter(Boolean);
  return (
    <p className="text-meta text-muted-foreground">
      By continuing, you agree to the {links[0]}
      {links.length > 1 && <> and {links[1]}</>}.
    </p>
  );
}

/* The official multicolor Google "G". Brand colors stay hardcoded — brand
 * marks do not theme. */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z"
      />
    </svg>
  );
}

export function SignInPage({
  providers,
  legal,
  defaultCreating = false,
}: {
  providers: Providers;
  legal: Legal;
  defaultCreating?: boolean;
}) {
  const session = authClient.useSession();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(defaultCreating);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const requestedReturnTo = search.get("returnTo");
  const returnTo =
    requestedReturnTo?.startsWith("/") && !requestedReturnTo.startsWith("//")
      ? requestedReturnTo
      : "/";
  if (session.data) return <Navigate to={returnTo} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email"));
    const password = String(data.get("password"));
    const result = creating
      ? await authClient.signUp.email({ name: String(data.get("name")), email, password })
      : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Authentication failed");
    else navigate(returnTo, { replace: true });
  }

  return (
    <AuthLayout
      title={creating ? "Create your Trema account" : "Sign in to Trema"}
      footer={<LegalFooter legal={legal} />}
    >
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {providers.password && (
          <form className="space-y-4" onSubmit={submit}>
            {creating && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" autoComplete="name" required />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={creating ? "new-password" : "current-password"}
                minLength={8}
                required
              />
            </div>
            <Button className="w-full" disabled={busy}>
              {busy ? "Please wait…" : creating ? "Create account" : "Sign in"}
            </Button>
          </form>
        )}
        {providers.password && providers.google && <OrDivider />}
        {providers.google && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              authClient.signIn.social({
                provider: "google",
                callbackURL: new URL(returnTo, window.location.origin).toString(),
              })
            }
          >
            <GoogleIcon />
            Continue with Google
          </Button>
        )}
        {providers.password && (
          <p className="text-center text-meta text-muted-foreground">
            {creating ? "Already have an account?" : "New to Trema?"}{" "}
            <button
              type="button"
              className="text-moss hover:underline"
              onClick={() => {
                setCreating(!creating);
                setError(undefined);
              }}
            >
              {creating ? "Sign in" : "Create account"}
            </button>
          </p>
        )}
      </div>
    </AuthLayout>
  );
}
