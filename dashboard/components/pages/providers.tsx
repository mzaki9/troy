import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, Brain, Check, ChevronsUpDown, Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { api, mask, useApi } from "../api";
import type { Connection, ProviderCat, SavedModel } from "../api";
import { CopyButton } from "../copy-button";
import { ProviderIcon } from "../provider-icon";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
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

/** Strip the status prefix off api() errors and surface the server's clean `error`/`detail`. */
function parseApiError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^\d+ (.*)$/.exec(msg);
  if (!m) return msg;
  try {
    const j = JSON.parse(m[1]) as { error?: string; detail?: string };
    return j.error ? (j.detail ? `${j.error} — ${j.detail}` : j.error) : m[1];
  } catch {
    return m[1];
  }
}

const GRID = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

export function ProvidersPage() {
  const [sel, setSel] = useState<string | null>(null);

  if (sel)
    return (
      <div key={sel} className="view-switch">
        <ProviderDetail id={sel} onBack={() => setSel(null)} />
      </div>
    );
  return (
    <div key="overview" className="view-switch">
      <Overview onOpen={setSel} />
    </div>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const providers = useApi<ProviderCat[]>("/api/providers");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-0">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Providers</CardTitle>
            <div className="flex items-center gap-2">
              <AddCustomDialog onAdded={providers.refetch} />
              <Badge variant="secondary">
                {providers.data ? `${providers.data.length} registered` : "…"}
              </Badge>
            </div>
          </div>
          <CardDescription>
            OpenAI-compatible chat-completions catalog — click a provider for its keys and models
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!providers.data ? (
            <div className={GRID}>
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-[68px] w-full" />
              ))}
            </div>
          ) : (
            <div className={GRID}>
              {providers.data.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpen(p.id)}
                  title={p.baseUrl}
                  className={cn(
                    "flex gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:border-black/40 dark:hover:border-white/40 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none",
                    p.connected && "border-aloe"
                  )}
                >
                  <ProviderIcon id={p.id} className="size-8 rounded-lg" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {p.name ?? p.id}
                      {p.custom ? (
                        <span className="ml-1.5 rounded bg-primary/10 px-1 py-px text-[9px] font-semibold tracking-wide text-primary uppercase">
                          custom
                        </span>
                      ) : null}
                    </p>
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          p.connected ? "bg-emerald-500" : "bg-muted-foreground/60"
                        )}
                      />
                      {p.connected ? `${p.connected} connected` : "no key"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProviderDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const providers = useApi<ProviderCat[]>("/api/providers");
  const connections = useApi<Connection[]>("/api/connections");

  const p = (providers.data ?? []).find((x) => x.id === id);
  const conns = (connections.data ?? []).filter((c) => c.provider === id);
  const placeholderKeys = p?.placeholders ?? [];

  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const toggleReveal = (cid: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });

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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="ghost" size="icon" onClick={onBack} aria-label="back to providers">
                <ArrowLeft className="size-4" />
              </Button>
              <ProviderIcon id={id} className="size-9 rounded-lg" />
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <span className="truncate">{p?.name ?? id}</span>
                  {p?.custom ? (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      custom
                    </Badge>
                  ) : null}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {p?.auth ?? "…"}
                  </Badge>
                </CardTitle>
                <CardDescription className="truncate">
                  {p?.aliases?.join(" · ") ?? "…"}
                </CardDescription>
              </div>
            </div>
            <Badge variant={conns.some((c) => c.is_active) ? "default" : "secondary"}>
              {conns.some((c) => c.is_active)
                ? `${conns.filter((c) => c.is_active).length} active key${conns.filter((c) => c.is_active).length > 1 ? "s" : ""}`
                : "no active key"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{p?.baseUrl ?? "…"}</code>
            <CopyButton what="endpoint" text={p?.baseUrl ?? ""} label="copy endpoint" />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            chat-completions endpoint — point opencode, cursor, cline or any OpenAI-compatible CLI
            at <code className="font-mono">{location.origin}/v1</code> and use{" "}
            <code className="font-mono">{id}/…</code> as the model.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Keys</CardTitle>
          <Badge variant="secondary">{conns.length} saved</Badge>
        </CardHeader>
        <CardContent>
          {!connections.data ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : conns.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No keys for {id} yet — paste one below.
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {conns.map((c) => {
                const show = revealed.has(c.id);
                return (
                  <div key={c.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {c.name ? (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
                          {c.name}
                        </span>
                      ) : null}
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        #{c.priority}
                      </span>
                      <code className="min-w-0 truncate font-mono text-xs">
                        {show ? c.api_key : mask(c.api_key)}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleReveal(c.id)}
                        aria-label={show ? "hide key" : "reveal key"}
                        title={show ? "hide key" : "reveal key"}
                      >
                        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </Button>
                      <CopyButton what={`key:${c.id}`} text={c.api_key} label="copy api key" />
                      <Switch
                        checked={c.is_active === 1}
                        onCheckedChange={() => toggle(c)}
                        aria-label={`toggle ${id} key`}
                      />
                      <DeleteDialog
                        title={`Remove this ${id} key?`}
                        description="This connection will be removed and can no longer serve requests."
                        onConfirm={() => remove(c)}
                      >
                        <Button variant="ghost" size="icon" aria-label={`remove ${id} key`} className="hover:text-destructive">
                          <Trash2 className="size-4" />
                        </Button>
                      </DeleteDialog>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>

        <div className="flex justify-end border-t px-8 pt-6">
          <AddKeyDialog
            providerId={id}
            placeholderKeys={placeholderKeys}
            onAdded={() => {
              connections.refetch();
              providers.refetch();
            }}
          />
        </div>
      </Card>

      <ModelsCard providerId={id} />
    </div>
  );
}

/** Live model catalog for a provider — auto-fetched, picking a model saves it as your choice. */
function ModelsCard({ providerId }: { providerId: string }) {
  const saved = useApi<SavedModel[]>("/api/models");
  const [models, setModels] = useState<{ id: string; name: string; thinking?: boolean }[] | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const mine = (saved.data ?? []).filter((m) => m.provider === providerId);
  const chosen = new Set(mine.map((m) => m.spec));

  const choose = async (id: string) => {
    await api("/api/models", { method: "POST", body: JSON.stringify({ provider: providerId, model: id }) });
    saved.refetch();
  };

  const unchoose = async (spec: string) => {
    await api(`/api/models/${encodeURIComponent(spec)}`, { method: "DELETE" });
    saved.refetch();
  };

  const fetchModels = async () => {
    setErr(null);
    try {
      const res = await api(`/api/providers/${providerId}/models`);
      const data = res as { models?: { id: string; name: string; thinking?: boolean }[]; url?: string };
      setModels(data.models ?? []);
      setUrl(data.url ?? null);
    } catch (e2) {
      setErr(parseApiError(e2));
    }
  };

  useEffect(() => {
    fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">models</CardTitle>
          {mine.length > 0 ? <Badge variant="secondary">{mine.length} chosen</Badge> : null}
        </div>
        <CardDescription className="font-mono text-[11px]">
          {url ?? "pick the models you use with this provider — they save automatically"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {err ? (
          <p className="text-xs text-red-600 dark:text-red-400">
            catalog unavailable: {err}
            {err.startsWith("no key") ? (
              <span className="text-muted-foreground"> — add a key for {providerId} first.</span>
            ) : null}
          </p>
        ) : models === null ? (
          <p className="text-xs text-muted-foreground">fetching catalog…</p>
        ) : models.length === 0 ? (
          <p className="text-xs text-muted-foreground">no models returned.</p>
        ) : (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={open}
                className="w-full justify-between font-mono text-xs"
              >
                {chosen.size > 0 ? `${chosen.size} chosen — add more…` : "choose a model…"}
                <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[min(380px,calc(100vw-2rem))] p-0"
              align="start"
              side="bottom"
            >
              <Command>
                <CommandInput placeholder="search models…" />
                <CommandList>
                  <CommandEmpty>no model found.</CommandEmpty>
                  <CommandGroup>
                    {models.slice(0, 500).map((m) => (
                      <CommandItem
                        key={m.id}
                        value={m.id}
                        onSelect={() => {
                          choose(m.id);
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate font-mono text-xs">{m.id}</p>
                            {m.thinking ? (
                              <Badge variant="secondary" className="shrink-0 px-2 py-0.5 text-[10px] font-medium">
                                <Brain className="size-3" />
                                thinking
                              </Badge>
                            ) : null}
                          </div>
                          {m.name !== m.id ? (
                            <p className="truncate text-[11px] text-muted-foreground">{m.name}</p>
                          ) : null}
                        </div>
                        <Check
                          className={cn(
                            "size-4 shrink-0",
                            chosen.has(`${providerId}/${m.id}`) ? "opacity-100" : "opacity-0"
                          )}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}

        {mine.length > 0 ? (
          <div className="divide-y divide-border/60 rounded-md border border-border">
            {mine.map((m) => (
              <div key={m.spec} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-xs">{m.model}</span>
                  {m.thinking ? (
                    <Badge variant="secondary" className="shrink-0 px-2 py-0.5 text-[10px] font-medium">
                      <Brain className="size-3" />
                      thinking
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <CopyButton what={`model:${m.spec}`} text={m.spec} label="copy provider/model" />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`remove ${m.spec}`}
                    className="hover:text-destructive"
                    onClick={() => unchoose(m.spec)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
/** Popup for adding a key to one provider — optional name, priority, placeholders. */
function AddKeyDialog({
  providerId,
  placeholderKeys,
  onAdded,
}: {
  providerId: string;
  placeholderKeys: string[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [prio, setPrio] = useState("0");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/connections", {
        method: "POST",
        body: JSON.stringify({
          provider: providerId,
          api_key: key.trim(),
          name: name.trim() || undefined,
          priority: Number(prio || 0),
          extra: placeholderKeys.length ? JSON.stringify(extras) : undefined,
        }),
      });
      setName("");
      setKey("");
      setPrio("0");
      setExtras({});
      setOpen(false);
      onAdded();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          add key
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add key — {providerId}</AlertDialogTitle>
          <AlertDialogDescription>Label it so you can tell your keys apart.</AlertDialogDescription>
        </AlertDialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="akName">name (optional)</Label>
            <Input
              id="akName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="work key, backup, team shared…"
            />
          </div>
          {placeholderKeys.map((pk) => (
            <div key={pk} className="flex flex-col gap-1.5">
              <Label htmlFor={`ak-${pk}`}>{pk}</Label>
              <Input
                id={`ak-${pk}`}
                value={extras[pk] ?? ""}
                onChange={(e) => setExtras((x) => ({ ...x, [pk]: e.target.value }))}
                placeholder={pk}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="akKey">api key</Label>
            <Input id="akKey" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="akPrio">priority</Label>
            <Input id="akPrio" type="number" value={prio} onChange={(e) => setPrio(e.target.value)} />
          </div>
          {err ? <p className="text-xs text-red-600 dark:text-red-400">{err}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" disabled={!key.trim() || busy}>
              add key
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Popup for registering an arbitrary OpenAI-compatible endpoint. */
function AddCustomDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [idv, setIdv] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState("bearer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!idv.trim() || !url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/custom-providers", {
        method: "POST",
        body: JSON.stringify({
          id: idv.trim().toLowerCase(),
          name: name.trim() || undefined,
          baseUrl: url.trim(),
          auth,
        }),
      });
      setIdv("");
      setName("");
      setUrl("");
      setAuth("bearer");
      setOpen(false);
      onAdded();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" />
          custom provider
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Add custom provider</AlertDialogTitle>
          <AlertDialogDescription>Any OpenAI-compatible chat-completions endpoint.</AlertDialogDescription>
        </AlertDialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cpId">id</Label>
            <Input
              id="cpId"
              value={idv}
              onChange={(e) => setIdv(e.target.value)}
              placeholder="my-provider"
              required
            />
            <p className="text-[11px] text-muted-foreground">
              1-32 chars, lowercase letters + dashes. Model prefix will be{" "}
              <code className="font-mono">{idv || "my-provider"}/…</code>
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cpName">name (optional)</Label>
            <Input
              id="cpName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Provider"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cpUrl">base url</Label>
            <Input
              id="cpUrl"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/v1/chat/completions"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cpAuth">auth</Label>
            <Select value={auth} onValueChange={setAuth}>
              <SelectTrigger id="cpAuth" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bearer">bearer (Authorization: Bearer)</SelectItem>
                <SelectItem value="raw">raw (x-api-key)</SelectItem>
                <SelectItem value="none">none (keyless)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {err ? <p className="text-xs text-red-600 dark:text-red-400">{err}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" disabled={!idv.trim() || !url.trim() || busy}>
              add
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
