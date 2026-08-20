import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Settings } from "../api";
import { api, useApi } from "../api";
import { Button } from "../ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { SecurityCard } from "./security";

const CAVEMAN_LEVELS = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"];
const PONYTAIL_LEVELS = ["off", "lite", "full", "ultra"];

function SettingSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value?: string;
  options: string[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <p className="text-sm font-medium">{label}</p>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function SettingsPage() {
  const settings = useApi<Settings>("/api/settings");
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const d = settings.data;
    if (d) setForm((prev) => prev ?? d);
  }, [settings.data]);

  const dirty = !!form && !!settings.data && JSON.stringify(form) !== JSON.stringify(settings.data);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const res = await api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(form) });
      setForm(res);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Routing &amp; token savers</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          {!form ? (
            <div className="space-y-5 py-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                  <Skeleton className="h-9 w-48" />
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0">
                <div>
                  <p className="text-sm font-medium">RTK token saver</p>
                  <p className="text-xs text-muted-foreground">
                    compress tool-result blocks (grep, ls, git diff, tree, find…)
                  </p>
                </div>
                <Switch
                  checked={form.rtk_on === 1}
                  onCheckedChange={(v) => setForm({ ...form, rtk_on: v ? 1 : 0 })}
                  aria-label="RTK token saver"
                />
              </div>
              <SettingSelect
                label="Account strategy"
                value={form.strategy}
                options={["fill-first", "round-robin"]}
                onChange={(v) => setForm({ ...form, strategy: v })}
              />
              <SettingSelect
                label="Caveman prompt"
                value={form.caveman_level}
                options={CAVEMAN_LEVELS}
                onChange={(v) => setForm({ ...form, caveman_level: v })}
              />
              <SettingSelect
                label="Ponytail"
                value={form.ponytail_level}
                options={PONYTAIL_LEVELS}
                onChange={(v) => setForm({ ...form, ponytail_level: v })}
              />
            </>
          )}
        </CardContent>
        <CardFooter className="justify-end border-t">
          <Button onClick={save} disabled={!dirty || saving}>
            {saved ? <Check className="size-4" /> : saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {saved ? "saved" : "save settings"}
          </Button>
        </CardFooter>
      </Card>
      <SecurityCard />
    </div>
  );
}
