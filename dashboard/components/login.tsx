import { Eye, EyeOff, Loader2, Lock, Moon, ShieldCheck, Sun } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toggleDark, useDark } from "../dark";
import { api } from "./api";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

/** Must match DEFAULT_DASHBOARD_PASS on the server (src/auth.ts). */
const DEFAULT_PASS = "troy123";

export function LoginPage({ defaultPass, onAuthed }: { defaultPass: boolean; onAuthed: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dark = useDark();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>("/api/login", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      onAuthed();
    } catch {
      setError("wrong password — try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dot-grid flex h-screen items-center justify-center overflow-hidden p-5 text-foreground">
      <button
        type="button"
        onClick={toggleDark}
        aria-label="toggle dark mode"
        title={dark ? "switch to light mode" : "switch to dark mode"}
        className="absolute top-5 right-5 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
      >
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>

      <Card className="w-full max-w-sm">
        <CardHeader className="items-center px-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Lock className="size-5" />
          </span>
          <CardTitle className="text-lg tracking-[0.02em]">troy</CardTitle>
          <CardDescription>enter the dashboard password to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="relative">
              <Input
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                autoFocus
                required
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? "hide password" : "show password"}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>

            {defaultPass && (
              <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  default password:{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                    {DEFAULT_PASS}
                  </code>{" "}
                  — change it under Settings after logging in
                </span>
              </div>
            )}

            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

            <Button type="submit" className="w-full" disabled={busy || !password}>
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> unlocking…
                </>
              ) : (
                "unlock dashboard"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
