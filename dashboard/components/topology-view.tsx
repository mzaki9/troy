import { useEffect, useRef } from "react";
import { createTopology } from "../topology";
import type { TopoData } from "../topology";

export function TopologyView({ data }: { data?: TopoData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const topoRef = useRef<ReturnType<typeof createTopology> | null>(null);

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

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />;
}
