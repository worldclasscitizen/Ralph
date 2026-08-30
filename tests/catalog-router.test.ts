import { describe, expect, it } from "vitest";
import { loadCatalog, catalogStatus } from "../src/catalog.js";
import { buildRoutes } from "../src/router.js";
import type { ConnectionConfig } from "../src/types.js";

describe("signed catalog and deterministic router", () => {
  it("verifies and loads the signed bootstrap catalog", async () => {
    const catalog = await loadCatalog();
    const status = await catalogStatus({ offline: true });
    expect(catalog.version).toBe(2);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(status.signatureValid).toBe(true);
  });

  it("produces stable diverse routes and a fast preset preference", async () => {
    const catalog = await loadCatalog();
    const connections: ConnectionConfig[] = [
      { id: "openai:codex-login", adapter: "codex-builtin", provider: "openai", enabled: true, mode: "builtin" },
      { id: "anthropic:claude-login", adapter: "claude-code-builtin", provider: "anthropic", enabled: true, mode: "builtin" },
      { id: "google:antigravity-login", adapter: "antigravity-builtin", provider: "google", enabled: true, mode: "builtin" },
    ];
    const first = buildRoutes(catalog, connections, "balanced");
    const second = buildRoutes(catalog, connections, "balanced");
    expect(first).toEqual(second);
    expect(new Set(first.backend_core.map((item) => item.provider)).size).toBeGreaterThan(1);
    const fast = buildRoutes(catalog, connections, "fast");
    expect(fast.frontend_visual[0]?.modelId).toBe("gemini-3.7-flash-high");
  });

  it("keeps a non-vision fallback with an explicit degradation marker", async () => {
    const catalog = await loadCatalog();
    const connections: ConnectionConfig[] = [
      { id: "deepseek:api", adapter: "deepseek-api", provider: "deepseek", enabled: true, mode: "api" },
    ];
    const routes = buildRoutes(catalog, connections, "balanced");
    expect(routes.frontend_visual).toHaveLength(1);
    expect(routes.frontend_visual[0]?.modelId).toBe("deepseek-v4-pro");
    expect(routes.frontend_visual[0]?.degradedCapabilities).toContain("vision");
  });
});
