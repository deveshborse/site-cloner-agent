import { closeBrowser } from "./analyze.ts";
import { reporter } from "./jobs.ts";
import { modifySite } from "./modify.ts";
import { cloneWebsite } from "./pipeline.ts";
import { ensurePreview, stopAllPreviews } from "./preview.ts";

/**
 * Terminal usage:
 *   npm run clone -- https://example.com            (add --keep to leave the preview server running)
 *   npm run modify -- <slug> "Make the navbar sticky"
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const keep = rest.includes("--keep");
  const args = rest.filter((a) => a !== "--keep");
  const rep = reporter(null);
  try {
    if (command === "clone" && args[0]) {
      const m = await cloneWebsite(args[0], rep);
      console.log(`\nDone: generated/${m.slug}`);
      console.log(`Similarity: ${((m.similarity ?? 0) * 100).toFixed(1)}%  |  LLM calls: ${m.usage.calls} (${m.usage.cachedCalls} cached)  |  est. cost: $${m.usage.costUsd.toFixed(4)}`);
      if (keep) console.log(`Preview: ${await ensurePreview(m.slug)}  (Ctrl+C to stop)`);
    } else if (command === "modify" && args[0] && args[1]) {
      const m = await modifySite(args[0], args.slice(1).join(" "), rep);
      console.log(`\nDone: ${m.history.at(-1)?.summary}`);
      if (keep) console.log(`Preview: ${await ensurePreview(m.slug)}  (Ctrl+C to stop)`);
    } else {
      console.log('Usage:\n  npm run clone -- <url> [--keep]\n  npm run modify -- <slug> "<instruction>" [--keep]');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (!keep) {
      stopAllPreviews();
      await closeBrowser();
    }
  }
}

process.on("SIGINT", () => {
  stopAllPreviews();
  process.exit(130);
});

main();
