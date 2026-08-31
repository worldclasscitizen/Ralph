import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Ralph",
  description: "Quality-first, evidence-driven multi-agent orchestration",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Reliability", link: "/reliability/verification" },
      { text: "Reference", link: "/reference/cli" },
      { text: "Roadmap", link: "/project/roadmap" },
    ],
    sidebar: [
      { text: "Getting started", items: [{ text: "Install and first run", link: "/getting-started" }, { text: "Adoption", link: "/ADOPTION" }] },
      { text: "Concepts", items: [{ text: "Quality-first routing", link: "/concepts/quality-routing" }, { text: "Architecture", link: "/ARCHITECTURE" }, { text: "Providers", link: "/PROVIDERS" }] },
      { text: "Reliability", items: [{ text: "Verification gates", link: "/reliability/verification" }, { text: "Benchmarks", link: "/reliability/benchmarks" }, { text: "Coverage baseline", link: "/reliability/COVERAGE_BASELINE" }, { text: "Control Center", link: "/RALPH_CONTROL_CENTER" }] },
      { text: "Reference", items: [{ text: "CLI", link: "/reference/cli" }, { text: "Releasing", link: "/RELEASING" }] },
      { text: "Project", items: [{ text: "Maturity", link: "/project/maturity" }, { text: "Roadmap", link: "/project/roadmap" }] },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/worldclasscitizen/multi-agent-ralph" }],
    search: { provider: "local" },
  },
});
