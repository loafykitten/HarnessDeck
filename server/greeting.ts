import { homedir } from "node:os";
import { join } from "node:path";
import { getAppConfig } from "./config";
import { listSessions } from "./sessions";

const CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");

export interface Greeting {
  salutation: string;          // "Good evening, Fenn" (or no name)
  weather: string | null;      // "74° · clear skies in Portland"
  whimsy: string;              // the haiku-generated line
}

const WEATHER_CODES: Record<number, string> = {
  0: "clear skies", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "icy fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "snow showers", 95: "thunderstorms",
  96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

interface WeatherInfo { text: string; tempF: number; place: string }
let weatherCache: { at: number; zip: string; data: WeatherInfo | null } = { at: 0, zip: "", data: null };

async function getWeather(zip: string): Promise<WeatherInfo | null> {
  if (!zip) return null;
  if (weatherCache.data && weatherCache.zip === zip && Date.now() - weatherCache.at < 15 * 60_000) {
    return weatherCache.data;
  }
  try {
    const geo = await (await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`)).json();
    const place = geo.places?.[0];
    if (!place) return null;
    const lat = place.latitude, lon = place.longitude;
    const wx = await (await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code&temperature_unit=fahrenheit`,
    )).json();
    const cur = wx.current;
    const data: WeatherInfo = {
      tempF: Math.round(cur.temperature_2m),
      text: WEATHER_CODES[cur.weather_code] ?? "weather unknown",
      place: place["place name"],
    };
    weatherCache = { at: Date.now(), zip, data };
    return data;
  } catch {
    return weatherCache.zip === zip ? weatherCache.data : null;
  }
}

const FALLBACK_WHIMSY = [
  "the gradients are drifting and the terminal is warm ✦",
  "somewhere, a token is becoming a semicolon ✦",
  "the neon's humming and your sessions kept the seat warm ✦",
  "fresh context, clean diffs, good vibes ✦",
];

let whimsyCache: { at: number; line: string | null } = { at: 0, line: null };
let whimsyInFlight = false;

/** Non-blocking: serves cache (or a fallback) immediately and regenerates in
    the background — `claude -p` can take 10–30s, far too slow for a request. */
function getWhimsy(name: string, weather: WeatherInfo | null): string {
  const fresh = whimsyCache.line && Date.now() - whimsyCache.at < 60 * 60_000;
  if (!fresh && !whimsyInFlight) {
    whimsyInFlight = true;
    generateWhimsy(name, weather)
      .catch(() => {})
      .finally(() => { whimsyInFlight = false; });
  }
  return whimsyCache.line
    ?? FALLBACK_WHIMSY[Math.floor(Math.random() * FALLBACK_WHIMSY.length)];
}

async function generateWhimsy(name: string, weather: WeatherInfo | null): Promise<void> {
  try {
    const sessions = await listSessions();
    const projects = [...new Set(sessions.map(s => s.project))].slice(0, 3).join(", ") || "no projects yet";
    const prompt =
      `Write ONE short, kind, cute, whimsical greeting line (max 14 words, lowercase, ` +
      `end with " ✦", no quotes, no emoji besides ✦) for a developer's dashboard. ` +
      `Context: name=${name || "friend"}; weather=${weather ? `${weather.tempF}°F ${weather.text} in ${weather.place}` : "unknown"}; ` +
      `active projects=${projects}. Reply with only the line.`;
    const p = Bun.spawn(
      [CLAUDE_BIN, "-p", prompt, "--model", "haiku", "--output-format", "text"],
      { stdout: "pipe", stderr: "ignore", env: { ...process.env } },
    );
    const timeout = setTimeout(() => p.kill(), 25_000);
    const out = (await new Response(p.stdout).text()).trim();
    clearTimeout(timeout);
    if (out && out.length < 140) {
      whimsyCache = { at: Date.now(), line: out };
    }
  } catch { /* keep previous cache/fallback */ }
}

function salutation(name: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

export async function getGreeting(): Promise<Greeting> {
  const cfg = await getAppConfig();
  // fall back to the account's display name until one is configured
  const name = cfg.displayName
    || (await import("./usage").then(u => u.getProfile()).catch(() => null))?.displayName
    || "";
  const weather = await getWeather(cfg.zip);
  const whimsy = cfg.greetingEnabled
    ? getWhimsy(name, weather)
    : "";
  return {
    salutation: salutation(name),
    weather: weather ? `${weather.tempF}° · ${weather.text} in ${weather.place}` : null,
    whimsy,
  };
}
