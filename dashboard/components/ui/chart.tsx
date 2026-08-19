import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/utils";

/**
 * shadcn/ui-style chart primitives (ChartContainer + ChartTooltipContent)
 * on top of Recharts. Self-contained — no framer-motion dependency.
 *
 * Colors are passed as literal hex on each series (fill="<hex>"), not CSS
 * vars: model names contain characters (/, .) that are invalid in CSS
 * variable names, which silently dropped the whole style rule.
 */

export interface ChartConfigItem {
  label?: string;
  color?: string;
}
export type ChartConfig = Record<string, ChartConfigItem>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function useChartConfig() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChartConfig must be used within a <ChartContainer />");
  return ctx;
}

export interface ChartTooltipPayloadEntry {
  dataKey?: string | number;
  name?: string;
  value?: number | string;
  color?: string;
  fill?: string;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}
export type ChartTooltipPayload = ChartTooltipPayloadEntry[];

function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: ChartTooltipPayloadEntry | undefined,
  key: string,
): ChartConfigItem | undefined {
  if (!payload) return undefined;
  const payloadPayload = payload.payload;
  let configLabelKey: string = key;
  if (typeof payload[key] === "string") configLabelKey = payload[key] as string;
  else if (payloadPayload && typeof payloadPayload[key] === "string") {
    configLabelKey = payloadPayload[key] as string;
  }
  return config[configLabelKey];
}

export interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  config: ChartConfig;
  children: React.ReactElement;
}

/** Responsive chart frame. Set the frame size via className (e.g. "h-[320px]"). */
export function ChartContainer({ className, children, config, ...props }: ChartContainerProps) {
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          "flex justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-foreground/10 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/30 [&_.recharts-surface]:outline-none",
          className,
        )}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

export interface ChartTooltipContentProps {
  active?: boolean;
  payload?: ChartTooltipPayload;
  className?: string;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  indicator?: "line" | "dot";
  label?: string;
  labelFormatter?: (value: unknown, payload: ChartTooltipPayload) => React.ReactNode;
  labelClassName?: string;
  color?: string;
  nameKey?: string;
  labelKey?: string;
  formatter?: (
    value: unknown,
    name: unknown,
    item: ChartTooltipPayloadEntry,
    index: number,
    entryPayload: unknown,
  ) => React.ReactNode;
}

/** Default tooltip: card-shaped, dot-per-series, mono values. */
export function ChartTooltipContent({
  active,
  payload,
  className,
  hideLabel = false,
  hideIndicator = false,
  indicator = "dot",
  label,
  labelFormatter,
  labelClassName,
  color,
  nameKey,
  labelKey,
  formatter,
}: ChartTooltipContentProps) {
  const { config } = useChartConfig();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey ?? item?.dataKey ?? "value"}`;
    const value =
      !labelKey && typeof label === "string" && config[label]?.label ? config[label].label : item?.payload?.[key];
    if (labelFormatter) return labelFormatter(value, payload);
    if (!value) return null;
    return <div className={cn("font-medium", labelClassName)}>{value as React.ReactNode}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload?.length) return null;

  return (
    <div
      className={cn(
        "grid min-w-[10rem] items-start gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 py-2 text-xs shadow-xl",
        className,
      )}
    >
      {tooltipLabel}
      <div className="grid max-h-48 gap-1 overflow-y-auto pr-1">
        {payload.map((item, index) => {
          const key = `${nameKey ?? item?.name ?? item?.dataKey ?? "value"}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);
          // prefer the series' actual fill (literal hex), then config color
          const indicatorColor = item?.fill ?? item?.color ?? itemConfig?.color ?? color ?? "#a1a1aa";
          const value = item?.value;
          return (
            <div key={String(item?.dataKey ?? index)} className="flex w-full flex-wrap items-center gap-2">
              {formatter && item && value !== undefined && item.name ? (
                formatter(value, item.name, item, index, item.payload)
              ) : (
                <>
                  {!hideIndicator && (
                    <span
                      className={cn("shrink-0 rounded-[2px]", indicator === "dot" && "size-2.5")}
                      style={{ backgroundColor: indicatorColor }}
                    />
                  )}
                  <span className="flex-1 text-muted-foreground">{itemConfig?.label ?? item?.name}</span>
                  {value !== undefined && (
                    <span className="font-mono font-medium tabular-nums">{value.toLocaleString()}</span>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
