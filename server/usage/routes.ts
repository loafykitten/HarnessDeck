import { err, json, type RouteHandler } from "../http";
import { getLimits, getMonth } from "./claude";
import { getCodexConfig, getCodexMode, getCodexPlan, setCodexMode } from "./codex-auth";
import { getCodexLimits, getCodexMonth, getCodexSpend } from "./codex-usage";

export const usageRoutes: RouteHandler = async (req, url) => {
  const { pathname } = url;

  if (pathname === "/api/usage" && req.method === "GET") {
    // Partial-failure tolerant: each piece degrades independently
    const [limits, month, codexConfig, codexLimits, codexMonth, codexSpend, codexPlan] = await Promise.allSettled([
      getLimits(), getMonth(), getCodexConfig(), getCodexLimits(), getCodexMonth(),
      getCodexSpend(), getCodexPlan(),
    ]);
    return json({
      limits: limits.status === "fulfilled" ? limits.value : null,
      month: month.status === "fulfilled" ? month.value : null,
      codex: {
        mode: codexConfig.status === "fulfilled" ? codexConfig.value.mode : "api",
        providerName: codexConfig.status === "fulfilled" ? codexConfig.value.providerName : null,
        limits: codexLimits.status === "fulfilled" ? codexLimits.value : null,
        month: codexMonth.status === "fulfilled" ? codexMonth.value : null,
        spend: codexSpend.status === "fulfilled" ? codexSpend.value : null,
        plan: codexPlan.status === "fulfilled" ? codexPlan.value : null,
      },
      errors: [
        ...(limits.status === "rejected" ? [`limits: ${limits.reason}`] : []),
        ...(limits.status === "fulfilled" && limits.value?.authExpired
          ? ["limits: Claude sign-in expired — run `claude` to reauthenticate"]
          : limits.status === "fulfilled" && limits.value?.stale
          ? [`limits: serving cached data from ${limits.value.fetchedAt ?? "unknown"} (${limits.value.staleReason ?? "stale"})`]
          : []),
        ...(month.status === "rejected" ? [`month: ${month.reason}`] : []),
        ...(codexMonth.status === "rejected" ? [`codex: ${codexMonth.reason}`] : []),
      ],
    });
  }

  // ---- Codex auth mode (API key vs ChatGPT OAuth) ----
  if (pathname === "/api/codex/mode") {
    if (req.method === "GET") return json({ mode: await getCodexMode() });
    if (req.method === "PUT") {
      const body = await req.json();
      if (body.mode !== "api" && body.mode !== "oauth") return err("mode must be 'api' or 'oauth'");
      const res = await setCodexMode(body.mode);
      if ("error" in res) return err(res.error, 409);
      return json(res);
    }
  }

  return null;
};
