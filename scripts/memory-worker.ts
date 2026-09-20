import { createJsonEventSink } from "../src/core/json-event-sink.ts";
import { runCurator } from "../src/core/pipeline.ts";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  process.stderr.write("memory-worker requires input and output paths\n");
  process.exit(2);
}

let peakRssBytes = process.memoryUsage().rss;
let peakHeapUsedBytes = process.memoryUsage().heapUsed;
let peakHeapTotalBytes = process.memoryUsage().heapTotal;
let peakExternalBytes = process.memoryUsage().external;
const sampler = setInterval(() => {
  const usage = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, usage.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
  peakHeapTotalBytes = Math.max(peakHeapTotalBytes, usage.heapTotal);
  peakExternalBytes = Math.max(peakExternalBytes, usage.external);
}, 5);
sampler.unref();

const sink = await createJsonEventSink({ outputPath, sourcePath: inputPath, force: false });
try {
  const result = await runCurator({ inputPath, onEvent: sink.write });
  await sink.commit();
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  // resourceUsage tracks the OS high-water mark and catches synchronous
  // allocation spikes that an event-loop timer can miss.
  peakRssBytes = Math.max(peakRssBytes, process.resourceUsage().maxRSS * 1024);
  process.stdout.write(`${JSON.stringify({
    peakRssBytes,
    peakHeapUsedBytes,
    peakHeapTotalBytes,
    peakExternalBytes,
    summary: result.summary,
    failureCodes: result.previewFailures.map((failure) => failure.code),
  })}\n`);
} catch (error) {
  await sink.abort();
  throw error;
} finally {
  clearInterval(sampler);
}
