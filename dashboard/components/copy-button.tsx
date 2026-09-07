import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";

/** Copy text to clipboard with transient check feedback. `what` disambiguates multiple buttons on one page. */
export function CopyButton({
  what = "copy",
  text,
  label,
  disabled,
  onCopied,
}: {
  what?: string;
  text: string;
  label: string;
  disabled?: boolean;
  onCopied?: () => void;
}) {
  const [ok, setOk] = useState<string | null>(null);
  const copy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setOk(what);
    onCopied?.();
    setTimeout(() => setOk((c) => (c === what ? null : c)), 1500);
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={copy}
      aria-label={label}
      title={label}
      className="size-7"
      disabled={disabled}
    >
      {ok === what ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
