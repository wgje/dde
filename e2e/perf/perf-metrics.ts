import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.cwd(), 'test-results', 'perf');
const outPath = path.join(outDir, 'current-metrics.json');

export function mergePerfMetrics(metrics: Record<string, number>): void {
  mkdirSync(outDir, { recursive: true });

  let existingMetrics: Record<string, number> = {};
  if (existsSync(outPath)) {
    try {
      const existing = JSON.parse(readFileSync(outPath, 'utf8')) as {
        metrics?: Record<string, number>;
      };
      existingMetrics = existing.metrics ?? {};
    } catch {
      existingMetrics = {};
    }
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        metrics: {
          ...existingMetrics,
          ...metrics,
        },
      },
      null,
      2
    ),
    'utf8'
  );
}
