import { ArrowRight, Brain, ChevronsUpDown, Plus, Trash2, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { Combo, SavedModel } from "../api";
import { api, useApi } from "../api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  useCommandState,
} from "../ui/command";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";

function DeleteComboDialog({
  name,
  onConfirm,
  children,
}: {
  name: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete combo "${name}"?`}</AlertDialogTitle>
          <AlertDialogDescription>Requests to this combo name will stop routing after deletion.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Model picker for a new combo.
 *
 * NOTE: the "use raw model" action is a forceMount CommandItem, NOT a
 * CommandItem nested inside CommandEmpty. A filterable item inside
 * CommandEmpty makes cmdk's `filtered.count` flip between 0 and 1 forever
 * (mount → count 1 → Empty hides the item → unmount → count 0 → Empty shows
 * it…) and React throws #185 "Maximum update depth exceeded". forceMount
 * items are excluded from filtering (upstream fix cmdk PR #143), so the
 * action item is shown manually via useCommandState instead.
 */
function DesiredResults({
  desired,
  query,
  onAdd,
  onAddRaw,
}: {
  desired: SavedModel[];
  query: string;
  onAdd: (spec: string) => void;
  onAddRaw: (spec: string) => void;
}) {
  const isEmpty = useCommandState((state) => state.filtered.count === 0);
  const showRawAction = isEmpty && query.includes("/");
  return (
    <>
      <CommandItem
        forceMount
        value={query}
        onSelect={() => onAddRaw(query)}
        className={cn(showRawAction ? null : "hidden")}
      >
        use “<span className="font-mono">{query}</span>”
      </CommandItem>
      {!query.includes("/") && (
        <CommandEmpty>
          <span className="text-muted-foreground">
            type as <span className="font-mono">provider/model</span> to add a raw model
          </span>
        </CommandEmpty>
      )}
      <CommandGroup heading="desired">
        {desired.map((m) => (
          <CommandItem key={m.spec} value={m.spec} onSelect={() => onAdd(m.spec)}>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.spec}</span>
            {m.thinking ? <Brain className="size-3 shrink-0 text-muted-foreground" /> : null}
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

function DesiredPicker({
  desired,
  query,
  onQuery,
  onAdd,
  onAddRaw,
}: {
  desired: SavedModel[];
  query: string;
  onQuery: (q: string) => void;
  onAdd: (spec: string) => void;
  onAddRaw: (spec: string) => void;
}) {
  return (
    <Command>
      <CommandInput placeholder="search desired models…" onValueChange={onQuery} />
      <CommandList>
        <DesiredResults desired={desired} query={query} onAdd={onAdd} onAddRaw={onAddRaw} />
      </CommandList>
    </Command>
  );
}

export function CombosPage() {
  const combos = useApi<Combo[]>("/api/combos");
  const desired = useApi<SavedModel[]>("/api/models");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const remove = async (c: Combo) => {
    await api(`/api/combos/${encodeURIComponent(c.name)}`, { method: "DELETE" });
    combos.refetch();
  };

  const addModel = (spec: string) => {
    if (!spec || added.includes(spec)) return;
    setAdded((a) => [...a, spec]);
  };

  const addRaw = (q: string) => {
    if (!q.includes("/")) return;
    addModel(q.trim());
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || added.length === 0) return;
    await api("/api/combos", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), models: added }),
    });
    setName("");
    setAdded([]);
    setAdding(false);
    combos.refetch();
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Combos</CardTitle>
        <span className="text-xs text-muted-foreground">one name → ordered fallback chain</span>
      </CardHeader>
      <CardContent>
        {!combos.data ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : combos.data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No combos yet — group providers into a fallback chain.
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {combos.data.map((c) => (
              <div key={c.name} className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm font-medium">{c.name}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {c.models.map((m, i) => (
                      <span key={m} className="flex items-center gap-1.5">
                        {i > 0 && <ArrowRight className="size-3 text-muted-foreground" />}
                        <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                          {m}
                        </Badge>
                      </span>
                    ))}
                  </div>
                </div>
                <DeleteComboDialog name={c.name} onConfirm={() => remove(c)}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`delete ${c.name}`}
                    className="hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </DeleteComboDialog>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3 border-t">
        {!adding ? (
          <Button variant="aloe" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            new combo
          </Button>
        ) : (
          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-32 flex-1 flex-col gap-1.5">
              <Label htmlFor="comboName">name</Label>
              <Input id="comboName" value={name} onChange={(e) => setName(e.target.value)} placeholder="primary" />
            </div>
            <div className="flex min-w-48 flex-[2] flex-col gap-1.5">
              <Label>
                models — pick from desired, or type <span className="font-mono text-xs">"provider/model"</span>
              </Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {added.map((m) => (
                  <Badge key={m} variant="secondary" className="gap-1.5 py-1 font-mono text-[11px] font-normal">
                    {m}
                    <button
                      type="button"
                      aria-label={`remove ${m}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setAdded((a) => a.filter((x) => x !== m))}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                <Popover
                  open={open}
                  onOpenChange={(o) => {
                    setOpen(o);
                    if (o) desired.refetch();
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={open}
                      className="font-mono text-xs"
                    >
                      {added.length === 0 ? "pick a model…" : "add more…"}
                      <ChevronsUpDown className="size-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[min(380px,calc(100vw-2rem))] p-0" align="start">
                    <DesiredPicker
                      desired={desired.data ?? []}
                      query={query}
                      onQuery={setQuery}
                      onAdd={addModel}
                      onAddRaw={addRaw}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <Button type="submit" disabled={!name.trim() || added.length === 0}>
              save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              cancel
            </Button>
          </form>
        )}
      </CardFooter>
    </Card>
  );
}
