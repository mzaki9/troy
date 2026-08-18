import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { api, useApi } from "../api";
import type { Combo } from "../api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
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
          <AlertDialogDescription>
            Requests to this combo name will stop routing after deletion.
          </AlertDialogDescription>
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

export function CombosPage() {
  const combos = useApi<Combo[]>("/api/combos");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [models, setModels] = useState("");

  const remove = async (c: Combo) => {
    await api(`/api/combos/${encodeURIComponent(c.name)}`, { method: "DELETE" });
    combos.refetch();
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const modelList = models.trim().split(/\s+/).filter(Boolean);
    if (!name.trim() || modelList.length === 0) return;
    await api("/api/combos", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), models: modelList }),
    });
    setName("");
    setModels("");
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
                  <Button variant="ghost" size="icon" aria-label={`delete ${c.name}`} className="hover:text-destructive">
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
              <Input
                id="comboName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="primary"
              />
            </div>
            <div className="flex min-w-48 flex-[2] flex-col gap-1.5">
              <Label htmlFor="comboModels">
                models — <span className="font-mono text-xs">"provider/model"</span> space separated
              </Label>
              <Input
                id="comboModels"
                value={models}
                onChange={(e) => setModels(e.target.value)}
                placeholder="openai/gpt-4o-mini deepseek/deepseek-chat groq/llama-3.3-70b"
              />
            </div>
            <Button type="submit" disabled={!name.trim() || !models.trim()}>
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