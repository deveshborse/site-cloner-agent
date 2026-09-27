import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./config.ts";
import { googleFontFamily, isWebFont } from "./colors.ts";
import type { DesignTokens, SiteManifest } from "./types.ts";

async function rootVersions(): Promise<Record<string, string>> {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  return pkg.dependencies ?? {};
}

const fontStack = (name: string) => {
  const clean = name.replace(/"/g, "");
  const family = googleFontFamily(clean);
  const names = family && family !== clean ? `"${clean}", "${family}"` : `"${clean}"`;
  return `${names}, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
};

export function globalsCss(t: DesignTokens): string {
  return `@import "tailwindcss";
@source "../components";
@source "../app";

/* Design tokens extracted from the original site. Edit these to re-theme the whole clone. */
@theme {
  --color-primary: ${t.primary};
  --color-background: ${t.background};
  --color-foreground: ${t.foreground};
  --color-muted: ${t.muted};
  --color-surface: ${t.surface};
  --color-border: ${t.border};
  --font-heading: ${fontStack(t.headingFont)};
  --font-body: ${fontStack(t.bodyFont)};
  --radius-theme: ${t.radius};
}

html {
  scroll-behavior: smooth;
}

body {
  background-color: var(--color-background);
  color: var(--color-foreground);
  font-family: var(--font-body);
  -webkit-font-smoothing: antialiased;
}

img,
svg {
  max-width: 100%;
}
`;
}

function googleFontHref(name: string): string {
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}:wght@300;400;500;600;700;800&display=swap`;
}

export function layoutTsx(m: Pick<SiteManifest, "title" | "description" | "lang" | "fonts">): string {
  const fonts = [...new Set(m.fonts.filter(isWebFont).map(googleFontFamily))].filter(Boolean);
  const links = fonts.map((f) => `        <link rel="stylesheet" href=${JSON.stringify(googleFontHref(f))} />`).join("\n");
  return `import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: ${JSON.stringify(m.title || "Cloned site")},
  description: ${JSON.stringify(m.description || "")},
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang=${JSON.stringify(m.lang || "en")}>
      <head>
${fonts.length ? `        <link rel="preconnect" href="https://fonts.googleapis.com" />\n        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />\n${links}` : ""}
      </head>
      <body>{children}</body>
    </html>
  );
}
`;
}

/** The page is always generated from the manifest, so adding/removing/reordering sections never needs an LLM. */
export function pageTsx(m: Pick<SiteManifest, "sections">): string {
  const imports = m.sections.map((s) => `import ${s.name} from "@/components/${s.name}";`).join("\n");
  const body = m.sections
    .map((s) => `      <div data-clone-section="${s.id}" className="${s.sticky ? "sticky top-0 z-50" : "contents"}">\n        <${s.name} />\n      </div>`)
    .join("\n");
  return `${imports}

export default function Home() {
  return (
    <main>
${body}
    </main>
  );
}
`;
}

export async function scaffoldProject(siteDir: string, manifest: SiteManifest) {
  const v = await rootVersions();
  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: manifest.slug,
        version: "0.1.0",
        private: true,
        description: `Frontend recreation of ${manifest.sourceUrl}`,
        scripts: { dev: "next dev", build: "next build", start: "next start" },
        dependencies: { next: v.next, react: v.react, "react-dom": v["react-dom"], "lucide-react": v["lucide-react"] },
        devDependencies: {
          typescript: v.typescript,
          tailwindcss: v.tailwindcss,
          "@tailwindcss/postcss": v["@tailwindcss/postcss"],
          postcss: v.postcss,
          "@types/react": v["@types/react"],
          "@types/react-dom": v["@types/react-dom"],
          "@types/node": v["@types/node"],
        },
      },
      null,
      2
    ) + "\n",
    "next.config.mjs": `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  eslint: { ignoreDuringBuilds: true },
  basePath: process.env.PREVIEW_BASE_PATH || undefined,
};

export default nextConfig;
`,
    "postcss.config.mjs": `export default {
  plugins: { "@tailwindcss/postcss": {} },
};
`,
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: false,
          skipLibCheck: true,
          strict: false,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: false,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./*"] },
        },
        include: ["next-env.d.ts", "app/**/*.tsx", "app/**/*.ts", "components/**/*.tsx"],
        exclude: ["node_modules", ".next", ".clone"],
      },
      null,
      2
    ) + "\n",
    "next-env.d.ts": `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`,
    ".gitignore": ".next/\nnode_modules/\n.clone/history/\n",
    "app/globals.css": globalsCss(manifest.tokens),
    "app/layout.tsx": layoutTsx(manifest),
    "app/page.tsx": pageTsx(manifest),
    "README.md": `# ${manifest.title || manifest.slug}

Frontend recreation of ${manifest.sourceUrl}, generated by Site Cloner Agent.

\`\`\`bash
npm install
npm run dev
\`\`\`

- \`components/\` holds one component per section of the original page.
- \`app/globals.css\` holds the design tokens (colours, fonts, radius) as Tailwind theme variables.
- \`clone.json\` is the agent's manifest of sections, tokens and edit history.
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(siteDir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  await fs.mkdir(path.join(siteDir, "components"), { recursive: true });
}

export async function writeManifestFiles(siteDir: string, manifest: SiteManifest) {
  manifest.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(siteDir, "app", "page.tsx"), pageTsx(manifest), "utf8");
  await fs.writeFile(path.join(siteDir, "app", "globals.css"), globalsCss(manifest.tokens), "utf8");
  await fs.writeFile(path.join(siteDir, "app", "layout.tsx"), layoutTsx(manifest), "utf8");
  await fs.writeFile(path.join(siteDir, "clone.json"), JSON.stringify(manifest, null, 2), "utf8");
}

export async function readManifest(siteDir: string): Promise<SiteManifest> {
  return JSON.parse(await fs.readFile(path.join(siteDir, "clone.json"), "utf8")) as SiteManifest;
}
