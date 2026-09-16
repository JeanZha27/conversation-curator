import { createJsonEventSink } from "../src/core/json-event-sink.ts";
import { runCurator } from "../src/core/pipeline.ts";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  process.stderr.write("memory-worker requires input and output paths\n");
  process.exit(2);
}

let peakRssBytes = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 5);
sampler.unref();

const sink = await createJsonEventSink({ outputPath, sourcePath: inputPath, force: false });
try {
  const result = await runCurator({ inputPath, onEvent: sink.write });
  await sink.commit();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  process.stdout.write(`${JSON.stringify({ peakRssBytes, summary: result.summary })}\n`);
} catch (error) {
  await sink.abort();
  throw error;
} finally {
  clearInterval(sampler);
}
