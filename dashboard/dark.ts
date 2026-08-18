import { useEffect, useState } from "react";

/* theme module — html.dark class + localStorage, subscribed by useDark() */

const KEY = "troy-dark";
let dark = false;
const subs = new Set<(v: boolean) => void>();

function apply(v: boolean) {
  dark = v;
  document.documentElement.classList.toggle("dark", v);
  subs.forEach((f) => f(v));
}

export function initDark() {
  const saved = localStorage.getItem(KEY);
  apply(saved ? saved === "1" : matchMedia("(prefers-color-scheme: dark)").matches);
}

export function isDark() {
  return dark;
}

export function toggleDark() {
  dark = !dark;
  apply(dark);
  localStorage.setItem(KEY, dark ? "1" : "0");
  return dark;
}

export function useDark() {
  const [d, setD] = useState(dark);
  useEffect(() => {
    subs.add(setD);
    return () => {
      subs.delete(setD);
    };
  }, []);
  return d;
}