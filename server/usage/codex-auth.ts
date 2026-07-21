import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_HOME = join(homedir(), ".codex");
// env override exists so tests can exercise the mode toggle on a copy
const CONFIG_TOML = process.env.HD_CODEX_CONFIG ?? join(CODEX_HOME, "config.toml");

/** "api" = a top-level `model_provider = …` line is active in config.toml
    (requests go to that provider on an API key); "oauth" = the line is
    commented out, so codex falls back to its ChatGPT login. Toggling is
    exactly commenting/uncommenting that one line — everything else in the
    file is left byte-identical. */
export type CodexMode = "api" | "oauth";

/** Top-level TOML keys can only appear before the first [section] header,
    so scope the match to that prefix — `model_provider` inside a section
    (or in a comment elsewhere) must not count. */
function topLevel(text: string): string {
  const i = text.search(/^\s*\[/m);
  return i === -1 ? text : text.slice(0, i);
}

export async function getCodexMode(): Promise<CodexMode> {
  const text = await Bun.file(CONFIG_TOML).text().catch(() => "");
  return /^[ \t]*model_provider[ \t]*=/m.test(topLevel(text)) ? "api" : "oauth";
}

export async function setCodexMode(mode: CodexMode): Promise<CodexMode | { error: string }> {
  const text = await Bun.file(CONFIG_TOML).text().catch(() => null);
  if (text === null) return { error: `cannot read ${CONFIG_TOML}` };
  const head = topLevel(text);
  let newHead: string;
  if (mode === "oauth") {
    if (!/^[ \t]*model_provider[ \t]*=/m.test(head)) return "oauth"; // already
    newHead = head.replace(/^([ \t]*)(model_provider[ \t]*=)/m, "$1# $2");
  } else {
    if (/^[ \t]*model_provider[ \t]*=/m.test(head)) return "api"; // already
    if (!/^[ \t]*#[ \t]*model_provider[ \t]*=/m.test(head)) {
      return { error: "no commented model_provider line in config.toml to re-enable" };
    }
    newHead = head.replace(/^([ \t]*)#[ \t]*(model_provider[ \t]*=)/m, "$1$2");
  }
  await Bun.write(CONFIG_TOML, newHead + text.slice(head.length));
  return mode;
}

/** Display name of the configured provider: resolves the (active or
    commented) model_provider id to its [model_providers.<id>] `name`,
    falling back to the id itself. Null when config.toml has no provider. */
export async function getCodexProvider(): Promise<string | null> {
  const text = await Bun.file(CONFIG_TOML).text().catch(() => "");
  const id = topLevel(text).match(/^[ \t]*(?:#[ \t]*)?model_provider[ \t]*=[ \t]*"([^"]+)"/m)?.[1];
  if (!id) return null;
  let inSection = false;
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[(.+?)\]\s*$/);
    if (header) {
      inSection = header[1] === `model_providers.${id}` || header[1] === `model_providers."${id}"`;
      continue;
    }
    if (!inSection) continue;
    const name = line.match(/^[ \t]*name[ \t]*=[ \t]*"([^"]+)"/);
    if (name) return name[1];
  }
  return id;
}

export interface CodexPlan {
  label: string;          // "ChatGPT Plus"
  renewsAt: string | null; // subscription_active_until
}

/** The ChatGPT plan rides in the id_token JWT that `codex login` stores in
    ~/.codex/auth.json — there is no profile endpoint to ask. The claim names
    the plan tier and the current subscription window's end (≈ renewal date).
    Null when codex has never logged in with ChatGPT (API-key-only setups). */
export async function getCodexPlan(): Promise<CodexPlan | null> {
  try {
    const auth = await Bun.file(join(CODEX_HOME, "auth.json")).json();
    const idToken: string = auth?.tokens?.id_token;
    if (!idToken) return null;
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64url").toString(),
    )["https://api.openai.com/auth"];
    const plan: string = payload?.chatgpt_plan_type;
    if (!plan) return null;
    return {
      label: `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`,
      renewsAt: payload.chatgpt_subscription_active_until ?? null,
    };
  } catch {
    return null;
  }
}
