import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString();
}
