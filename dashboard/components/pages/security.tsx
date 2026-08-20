import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { Button } from "../ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function SecurityCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 4;
  const dirty = current.length > 0 && next.length >= 4 && next === confirm;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api<{ ok: boolean }>("/api/password", { method: "POST", body: JSON.stringify({ current, next }) });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: "password updated — it's in effect the next time you log in" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "could not change password" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dashboard password</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="current-pass">Current password</Label>
          <Input
            id="current-pass"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-pass">New password</Label>
          <Input
            id="new-pass"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="at least 4 characters"
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-pass">Confirm new password</Label>
          <Input
            id="confirm-pass"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="repeat the new password"
            autoComplete="new-password"
          />
        </div>
        {tooShort && (
          <p className="text-xs text-red-600 dark:text-red-400">the new password needs at least 4 characters</p>
        )}
        {mismatch && <p className="text-xs text-red-600 dark:text-red-400">passwords don't match</p>}
        {msg && (
          <p
            className={
              msg.ok ? "text-xs text-emerald-600 dark:text-emerald-400" : "text-xs text-red-600 dark:text-red-400"
            }
          >
            {msg.text}
          </p>
        )}
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button onClick={save} disabled={!dirty || busy}>
          {msg?.ok ? <Check className="size-4" /> : busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {msg?.ok ? "saved" : busy ? "saving…" : "update password"}
        </Button>
      </CardFooter>
    </Card>
  );
}
