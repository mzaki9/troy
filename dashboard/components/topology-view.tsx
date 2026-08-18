import { useEffect, useRef } from "react";
import { createTopology } from "../topology";
import type { TopoData } from "../topology";
import { useDark } from "../dark";

export function TopologyView({ data }: { data?: TopoData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const topoRef = useRef<ReturnType<typeof createTopology> | null>(null);
  const dark = useDark();

  useEffect(() => {
    if (!canvasRef.current) return;
    const topo = createTopology(canvasRef.current);
    topoRef.current = topo;
    return () => {
      topo.destroy();
      topoRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (data) topoRef.current?.setData(data);
  }, [data]);

  useEffect(() => {
    topoRef.current?.setDark(dark);
  }, [dark]);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />;
}