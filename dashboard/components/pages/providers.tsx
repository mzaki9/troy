import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { providerColor } from "../../topology";
import { api, mask, useApi } from "../api";
import type { Connection, ProviderCat } from "../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";

function DeleteDialog({
  title,
  description,
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={onConfirm}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ProvidersPage() {
  const providers = useApi<ProviderCat[]>("/api/providers");
  const connections = useApi<Connection[]>("/api/connections");

  // add-connection form state
  const [provSel, setProvSel] = useState("");
  const [key, setKey] = useState("");
  const [prio, setPrio] = useState("0");
  const [busy, setBusy] = useState(false);

  const toggle = async (c: Connection) => {
    await api(`/api/connections/${c.id}`, {
      method: "PUT",
      body: JSON.stringify({ is_active: c.is_active ? 0 : 1 }),
    });
    connections.refetch();
    providers.refetch();
  };

  const remove = async (c: Connection) => {
    await api(`/api/connections/${c.id}`, { method: "DELETE" });
    connections.refetch();
    providers.refetch();
  };

  const addConnection = async (e: FormEvent) => {
    e.preventDefault();
    if (!provSel || !key.trim()) return;
    setBusy(true);
    try {
      await api("/api/connections", {
        method: "POST",
        body: JSON.stringify({ provider: provSel, api_key: key.trim(), priority: Number(prio || 0) }),
      });
      setKey("");
      setPrio("0");
      connections.refetch();
      providers.refetch();
    } finally {
      setBusy(false);
    }
  };

  const connected = (connections.data ?? []).filter((c) => c.is_active).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-0">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Providers</CardTitle>
            <Badge variant="secondary">
              {providers.data ? `${providers.data.length} registered` : "…"}
            </Badge>
          </div>
          <CardDescription>OpenAI-compatible catalog</CardDescription>
        </CardHeader>
        <CardContent>
          {!providers.data ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-[68px] w-full" />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {providers.data.map((p) => (
                <Card
                  key={p.id}
                  title={p.id}
                  className={cn(
                    "gap-0 px-4 py-3 transition-colors hover:border-primary/40",
                    p.connected && "border-emerald-500/40"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold"
                      style={{
                        background: providerColor(p.id) + "26",
                        color: providerColor(p.id),
                      }}
                    >
                      {p.id.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.id}</p>
                      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span
                          className={cn(
                            "size-1.5",
                            p.connected ? "bg-emerald-500" : "bg-muted-foreground/60"
                          )}
                        />
                        {p.connected ? `${p.connected} connected` : "no key"}
                      </p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Connections</CardTitle>
          <Badge variant="secondary">
            {connections.data ? `${connected} connected` : "…"}
          </Badge>
        </CardHeader>
        <CardContent>
          {!connections.data ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : connections.data.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No connections yet — add a provider key above.
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {connections.data.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{c.provider}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      #{c.priority}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {mask(c.api_key)}
                    </span>
                    {c.base_url ? (
                      <span className="max-w-56 truncate font-mono text-[11px] text-muted-foreground">
                        {c.base_url}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      checked={c.is_active === 1}
                      onCheckedChange={() => toggle(c)}
                      aria-label={`toggle ${c.provider}`}
                    />
                    <DeleteDialog
                      title={`Remove ${c.provider} key?`}
                      description="This connection will be removed and can no longer serve requests."
                      onConfirm={() => remove(c)}
                    >
                      <Button variant="ghost" size="icon" aria-label={`remove ${c.provider} key`}>
                        <Trash2 className="size-4" />
                      </Button>
                    </DeleteDialog>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>

        <form
          onSubmit={addConnection}
          className="flex flex-wrap items-end gap-3 border-t px-6 pt-6"
        >
          <div className="flex min-w-28 flex-1 flex-col gap-1.5">
            <Label htmlFor="connProv">provider</Label>
            <Select value={provSel} onValueChange={setProvSel}>
              <SelectTrigger id="connProv" className="w-full">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {(providers.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-40 flex-[2] flex-col gap-1.5">
            <Label htmlFor="connKey">api key</Label>
            <Input
              id="connKey"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div className="flex w-24 flex-col gap-1.5">
            <Label htmlFor="connPrio">priority</Label>
            <Input
              id="connPrio"
              type="number"
              value={prio}
              onChange={(e) => setPrio(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={!provSel || !key.trim() || busy}>
            <Plus className="size-4" />
            add
          </Button>
        </form>
      </Card>
    </div>
  );
}