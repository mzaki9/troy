export interface TopoProvider {
  id: string;
  label: string;
  state: "active" | "error" | "last" | "idle";
  count: number;
  ok: number;
}
export interface TopoData {
  activeCount: number;
  providers: TopoProvider[];
}

const COLORS: Record<string, string> = {
  openai: "#10a37f",
  deepseek: "#4d6bfe",
  groq: "#f55036",
  openrouter: "#2f7cf6",
  mistral: "#f7a600",
  xai: "#9ca3af",
  cerebras: "#0081cc",
  together: "#00a6ff",
  nvidia: "#76b900",
  glm: "#5b8cff",
  venice: "#a855f7",
  cohere: "#5a4fcf",
  perplexity: "#5fc98f",
  cloudflare: "#f6821f",
  github: "#a371f7",
  anthropic: "#d97757",
  gemini: "#4285f4",
};

export function providerColor(id: string): string {
  if (COLORS[id]) return COLORS[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}

const ROUTER_W = 150;
const ROUTER_H = 68;
const NODE_W = 190;
const NODE_H = 44;

interface Cam {
  x: number;
  y: number;
  scale: number;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface EdgeP {
  p0: { x: number; y: number };
  p: { c1x: number; c1y: number; c2x: number; c2y: number; ex: number; ey: number };
}

function point(p0: { x: number; y: number }, p: EdgeP["p"], t: number) {
  const t1 = 1 - t;
  return {
    x: t1 * t1 * t1 * p0.x + 3 * t1 * t1 * t * p.c1x + 3 * t1 * t * t * p.c2x + t * t * t * p.ex,
    y: t1 * t1 * t1 * p0.y + 3 * t1 * t1 * t * p.c1y + 3 * t1 * t * t * p.c2y + t * t * t * p.ey,
  };
}

export function createTopology(
  canvas: HTMLCanvasElement,
  initial: TopoData = { activeCount: 0, providers: [] }
): { setData(d: TopoData): void; destroy(): void } {
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  let data = initial;
  let w = 0;
  let h = 0;
  const cam: Cam = { x: 0, y: 0, scale: 1 };
  const ring = new Map<string, { x: number; y: number }>();
  let raf = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function fit() {
    if (data.providers.length === 0) {
      cam.scale = 1;
      cam.x = w / 2;
      cam.y = h / 2;
      return;
    }
    layout();
    let minX = -ROUTER_W / 2 - 20, maxX = ROUTER_W / 2 + 20, minY = -ROUTER_H / 2 - 20, maxY = ROUTER_H / 2 + 20;
    for (const p of data.providers) {
      const n = ring.get(p.id)!;
      minX = Math.min(minX, n.x - NODE_W / 2);
      maxX = Math.max(maxX, n.x + NODE_W / 2);
      minY = Math.min(minY, n.y - NODE_H / 2);
      maxY = Math.max(maxY, n.y + NODE_H / 2);
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    cam.scale = Math.min(w / bw, h / bh) * 0.8;
    cam.x = w / 2 - ((minX + maxX) / 2) * cam.scale;
    cam.y = h / 2 - ((minY + maxY) / 2) * cam.scale;
  }

  function layout() {
    ring.clear();
    const n = data.providers.length;
    const rx = Math.max(320, ((NODE_W + 24) * n) / (2 * Math.PI));
    const ry = rx * 0.55;
    data.providers.forEach((p, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      ring.set(p.id, { x: rx * Math.cos(a), y: ry * Math.sin(a) });
    });
  }

  function edgePoints(id: string): { p0: { x: number; y: number }; p: { c1x: number; c1y: number; c2x: number; c2y: number; ex: number; ey: number } } {
    const n = ring.get(id)!;
    const sx = n.x >= 0 ? ROUTER_W / 2 : -ROUTER_W / 2;
    const ex = n.x >= 0 ? n.x - NODE_W / 2 : n.x + NODE_W / 2;
    const p0 = { x: sx, y: 0 };
    const dx = ex - sx;
    return { p0, p: { c1x: sx + dx * 0.35, c1y: (n.y - 0) * 0.15, c2x: sx + dx * 0.65, c2y: (n.y - 0) * 0.85, ex, ey: n.y } };
  }

  function strokeEdge(id: string) {
    const { p0, p } = edgePoints(id);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p.c1x, p.c1y, p.c2x, p.c2y, p.ex, p.ey);
    ctx.stroke();
  }

  function beam(id: string, t: number) {
    const e = edgePoints(id);
    ctx.strokeStyle = "rgba(193,251,212,0.85)"; /* aloe halo */
    ctx.lineWidth = 10;
    strokeEdge(id);
    ctx.strokeStyle = "#86efac";
    ctx.lineWidth = 5;
    strokeEdge(id);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2.2;
    strokeEdge(id);
    for (let i = 0; i < 4; i++) {
      const frac = (t * 0.6 + (i * 0.25 + 0.125)) % 1;
      const pt = point(e.p0, e.p, frac);
      const r = i % 2 ? 2.5 : 4;
      ctx.fillStyle = i % 2 ? "#000000" : "#34d399";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 5; i++) {
      const frac = (t * 0.6 + i / 5) % 1;
      const pt = point(e.p0, e.p, frac);
      ctx.fillStyle = "#c1fbd4";
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 6 + i * 2);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawEdge(p: TopoProvider, t: number) {
    switch (p.state) {
      case "active":
        beam(p.id, t);
        break;
      case "error":
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.9;
        strokeEdge(p.id);
        ctx.globalAlpha = 1;
        break;
      case "last":
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        strokeEdge(p.id);
        ctx.globalAlpha = 1;
        break;
      default:
        ctx.strokeStyle = "#d4d4d8";
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.9;
        strokeEdge(p.id);
        ctx.globalAlpha = 1;
    }
  }

  function drawRouter(t: number) {
    const x = -ROUTER_W / 2;
    const y = -ROUTER_H / 2;
    const active = data.activeCount > 0;
    ctx.save();
    ctx.shadowColor = "#c1fbd4";
    ctx.shadowBlur = active ? 28 : 0;
    if (active) {
      const g = ctx.createLinearGradient(x, y, x + ROUTER_W, y + ROUTER_H);
      g.addColorStop(0, "rgba(193,251,212,0.95)");
      g.addColorStop(0.5, "rgba(212,249,224,0.95)");
      g.addColorStop(1, "rgba(193,251,212,0.95)");
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.03)";
    }
    rr(ctx, x, y, ROUTER_W, ROUTER_H, 6);
    ctx.fill();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = active ? 2 : 1.5;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#000000";
    ctx.font = "600 15px Geist, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("troy", 0, 0);
    const pill = { x: ROUTER_W / 2 - 4, y: -ROUTER_H / 2 - 2, w: 26, h: 18 };
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#000000";
    rr(ctx, pill.x, pill.y, pill.w, pill.h, 3);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 11px Geist, system-ui, sans-serif";
    ctx.fillText(String(data.activeCount), pill.x + pill.w / 2, pill.y + pill.h / 2 + 0.5);
    ctx.restore();
    void t;
  }

  function drawProvider(p: TopoProvider) {
    const n = ring.get(p.id)!;
    const x = n.x - NODE_W / 2;
    const y = n.y - NODE_H / 2;
    const color = providerColor(p.id);
    ctx.save();
    ctx.shadowColor = p.state === "active" ? color : "transparent";
    ctx.shadowBlur = p.state === "active" ? 16 : 0;
    ctx.fillStyle = "#ffffff";
    rr(ctx, x, y, NODE_W, NODE_H, 5);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = p.state === "active" ? 2 : 1;
    ctx.strokeStyle = p.state === "active" ? "#000000" : p.state === "error" ? "#ef4444" : p.state === "last" ? "#f59e0b" : "#e4e4e7";
    ctx.stroke();
    ctx.restore();

    const chipX = x + 10;
    const chipY = y + (NODE_H - 32) / 2;
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    rr(ctx, chipX, chipY, 32, 32, 5);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = "700 12px Geist, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.label.slice(0, 2).toUpperCase(), chipX + 16, chipY + 17);
    ctx.restore();

    ctx.fillStyle = p.state === "active" ? color : "#000000";
    ctx.font = "600 13px Geist, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const label = p.label.length > 16 ? p.label.slice(0, 15) + "…" : p.label;
    ctx.fillText(label, chipX + 40, n.y);

    if (p.state === "active") {
      const pulse = (performance.now() / 1000) % 1;
      ctx.strokeStyle = "#000000";
      ctx.globalAlpha = 0.75 * (1 - pulse);
      ctx.beginPath();
      ctx.arc(x + NODE_W - 18, n.y, 4 + 6 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(x + NODE_W - 18, n.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw() {
    const t = performance.now() / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "transparent";
    ctx.clearRect(0, 0, w, h);
    if (data.providers.length === 0) return;
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.scale, cam.scale);
    for (const p of data.providers) drawEdge(p, t);
    drawRouter(t);
    for (const p of data.providers) drawProvider(p);
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!document.hidden) draw();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = r.width;
    h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    fit();
  }

  function onDown(e: PointerEvent) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return;
    cam.x += e.clientX - lastX;
    cam.y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  }
  function onUp(e: PointerEvent) {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = (mx - cam.x) / cam.scale;
    const worldY = (my - cam.y) / cam.scale;
    const factor = Math.exp(-e.deltaY * 0.0015);
    cam.scale = Math.min(2, Math.max(0.1, cam.scale * factor));
    cam.x = mx - worldX * cam.scale;
    cam.y = my - worldY * cam.scale;
  }
  function onDbl() {
    fit();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDbl);
  window.addEventListener("resize", resize);

  resize();
  raf = requestAnimationFrame(loop);

  return {
    setData(d: TopoData) {
      data = d;
      fit();
    },
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
      window.removeEventListener("resize", resize);
    },
  };
}