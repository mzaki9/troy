import { useState } from "react";
import { Brain, Check, ChevronsUpDown, Copy, Plus, Trash2 } from "lucide-react";
import { api, useApi } from "../api";
import type { ProviderCat, SavedModel } from "../api";
import { ProviderIcon } from "../provider-icon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";

function CopySpec({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`copy ${text}`}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        });
      }}
    >
      {ok ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
    </Button>
  );
}

function ThinkingTag({ className }: { className?: string }) {
  return (
    <Badge variant="secondary" className={`px-2 py-0.5 text-[10px] font-medium ${className ?? ""}`}>
      <Brain className="size-3" />
      thinking
    </Badge>
  );
}

/** Desired-model library — pick from a live catalog or type, combos select from here. */
export function ModelsPage() {
  const models = useApi<SavedModel[]>("/api/models");
  const catalog = useApi<ProviderCat[]>("/api/providers");
  const [prov, setProv] = useState("");
  const [modelId, setModelId] = useState("");
  const [catalogModels, setCatalogModels] = useState<{ id: string; name: string; thinking?: boolean }[] | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const pickProvider = async (p: string) => {
    setProv(p);
    setCatalogModels(null);
    setFetchErr(null);
    setBusy(true);
    try {
      const res = (await api(`/api/providers/${p}/models`)) as {
        models?: { id: string; name: string; thinking?: boolean }[];
        error?: string;
      };
      if (res.error) setFetchErr(res.error);
      else setCatalogModels(res.models ?? []);
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!prov || !modelId.trim()) return;
    await api("/api/models", {
      method: "POST",
      body: JSON.stringify({ provider: prov, model: modelId.trim() }),
    });
    setModelId("");
    models.refetch();
  };

  const remove = async (spec: string) => {
    await api(`/api/models/${encodeURIComponent(spec)}`, { method: "DELETE" });
    models.refetch();
  };

  const providers = catalog.data ?? [];

  return (
    <>
      <Card>
        <CardHeader className="gap-1">
          <CardTitle>desired models</CardTitle>
          <CardDescription>
            your personal catalog — combos pick from here, and <code className="font-mono">/v1/models</code> advertises
            them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-40 flex-col gap-1.5">
              <Label>provider</Label>
              <Select value={prov} onValueChange={pickProvider}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="choose provider…" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name ?? p.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-56 flex-[2] flex-col gap-1.5">
              <Label>model id</Label>
              <div className="flex gap-2">
                <Input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                  placeholder="deepseek-chat"
                  className="font-mono"
                />
                {catalogModels && catalogModels.length > 0 ? (
                  <Popover open={open} onOpenChange={setOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" role="combobox" aria-expanded={open} disabled={busy}>
                        {busy ? "fetching…" : "catalog"}
                        <ChevronsUpDown className="size-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[min(380px,calc(100vw-2rem))] p-0" align="end">
                      <Command>
                        <CommandInput placeholder={`search ${prov} models…`} />
                        <CommandList>
                          <CommandEmpty>no model found.</CommandEmpty>
                          <CommandGroup>
                            {catalogModels.slice(0, 500).map((m) => (
                              <CommandItem
                                key={m.id}
                                value={m.id}
                                onSelect={() => {
                                  setModelId(m.id);
                                  setOpen(false);
                                }}
                              >
                                <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                                {m.thinking ? <ThinkingTag /> : null}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                ) : null}
              </div>
              {fetchErr ? (
                <p className="text-[11px] text-red-600">
                  catalog fetch failed: {fetchErr} — type the id manually.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  thinking models flag automatically — append{" "}
                  <code className="font-mono">-low / -medium / -high</code> for reasoning depth.
                </p>
              )}
            </div>
            <Button variant="aloe" onClick={add} disabled={!prov || !modelId.trim() || busy}>
              <Plus className="size-4" />
              add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>your catalog</CardTitle>
          <span className="text-xs text-muted-foreground">{models.data?.length ?? "…"} saved</span>
        </CardHeader>
        <CardContent>
          {!models.data ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : models.data.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No desired models yet — add one above.
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {models.data.map((m) => (
                <div key={m.spec} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ProviderIcon id={m.provider} className="size-5 rounded" />
                    <span className="truncate font-mono text-xs">{m.spec}</span>
                    {m.thinking ? <ThinkingTag className="hidden sm:inline-flex" /> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {m.thinking ? <ThinkingTag className="sm:hidden" /> : null}
                    <CopySpec text={m.spec} />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`remove ${m.spec}`}
                      className="hover:text-destructive"
                      onClick={() => remove(m.spec)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
