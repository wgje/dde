/**
 * Lighthouse 性能指标提取脚本
 * 从 Lighthouse JSON 报告中提取关键指标并生成汇总
 * 
 * 用法: node scripts/extract-lighthouse-metrics.cjs
 */

const fs = require('fs');
const path = require('path');

const PERF_DIR = path.join(__dirname, '..', 'dist', 'perf');
const OUTPUT_FILE = path.join(PERF_DIR, 'metrics-summary.json');

/**
 * 性能目标（根据研究文档）
 */
const TARGETS = {
  lcp: 1500,      // LCP < 1500ms (目标)
  fcp: 1000,      // FCP < 1000ms
  cls: 0.1,       // CLS < 0.1
  tbt: 200,       // TBT < 200ms
  si: 2000,       // Speed Index < 2000ms
};

/**
 * 基线数据（优化前）
 */
const BASELINE = {
  lcp: 1943,
  renderDelay: 1872,
  cls: 0.00,
  ttfb: 71,
};

/**
 * 从 Lighthouse 报告提取指标
 */
function extractMetrics(report) {
  if (!report || !report.audits) {
    return null;
  }

  const audits = report.audits;
  
  return {
    // 核心 Web Vitals
    lcp: audits['largest-contentful-paint']?.numericValue || 0,
    fcp: audits['first-contentful-paint']?.numericValue || 0,
    cls: audits['cumulative-layout-shift']?.numericValue || 0,
    
    // 其他关键指标
    tbt: audits['total-blocking-time']?.numericValue || 0,
    tti: audits['interactive']?.numericValue || 0,
    si: audits['speed-index']?.numericValue || 0,
    ttfb: audits['server-response-time']?.numericValue || 0,
    
    // 总体性能评分
    performanceScore: (report.categories?.performance?.score || 0) * 100,
  };
}

/**
 * 计算平均值
 */
function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 格式化时间
 */
function formatTime(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * 评估指标状态
 */
function evaluateMetric(name, value, target) {
  if (value <= target) return '✅ 达标';
  if (value <= target * 1.2) return '⚠️ 接近';
  return '❌ 超标';
}

/**
 * 主函数
 */
function main() {
  console.log('📊 提取 Lighthouse 性能指标...\n');
  
  // 确保目录存在
  if (!fs.existsSync(PERF_DIR)) {
    fs.mkdirSync(PERF_DIR, { recursive: true });
  }
  
  // 查找所有 Lighthouse 报告
  const reportFiles = fs.readdirSync(PERF_DIR)
    .filter(f => f.startsWith('lighthouse-run-') && f.endsWith('.json'));
  
  if (reportFiles.length === 0) {
    console.log('⚠️ 未找到 Lighthouse 报告文件');
    console.log('   请先运行 npm run perf:benchmark');
    return;
  }
  
  // 提取所有报告的指标
  const allMetrics = [];
  
  for (const file of reportFiles) {
    try {
      const reportPath = path.join(PERF_DIR, file);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const metrics = extractMetrics(report);
      if (metrics) {
        allMetrics.push(metrics);
        console.log(`  ✓ ${file}: LCP=${formatTime(metrics.lcp)}, CLS=${metrics.cls.toFixed(3)}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ 解析 ${file} 失败:`, e.message);
    }
  }
  
  if (allMetrics.length === 0) {
    console.log('❌ 没有有效的性能数据');
    return;
  }
  
  // 计算平均值
  const avgMetrics = {
    lcp: average(allMetrics.map(m => m.lcp)),
    fcp: average(allMetrics.map(m => m.fcp)),
    cls: average(allMetrics.map(m => m.cls)),
    tbt: average(allMetrics.map(m => m.tbt)),
    tti: average(allMetrics.map(m => m.tti)),
    si: average(allMetrics.map(m => m.si)),
    ttfb: average(allMetrics.map(m => m.ttfb)),
    performanceScore: average(allMetrics.map(m => m.performanceScore)),
  };
  
  // 生成汇总
  const summary = {
    timestamp: new Date().toISOString(),
    runs: allMetrics.length,
    baseline: BASELINE,
    targets: TARGETS,
    current: avgMetrics,
    improvements: {
      lcp: BASELINE.lcp - avgMetrics.lcp,
      lcpPercent: ((BASELINE.lcp - avgMetrics.lcp) / BASELINE.lcp * 100).toFixed(1) + '%',
    },
    evaluations: {
      lcp: evaluateMetric('LCP', avgMetrics.lcp, TARGETS.lcp),
      fcp: evaluateMetric('FCP', avgMetrics.fcp, TARGETS.fcp),
      cls: evaluateMetric('CLS', avgMetrics.cls, TARGETS.cls),
      tbt: evaluateMetric('TBT', avgMetrics.tbt, TARGETS.tbt),
    },
  };
  
  // 保存汇总
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2));
  
  // 输出结果
  console.log('\n' + '='.repeat(50));
  console.log('📈 性能指标汇总');
  console.log('='.repeat(50));
  console.log(`测试次数: ${allMetrics.length}`);
  console.log(`性能评分: ${avgMetrics.performanceScore.toFixed(0)}/100`);
  console.log('');
  console.log('核心 Web Vitals:');
  console.log(`  LCP:  ${formatTime(avgMetrics.lcp).padEnd(10)} ${summary.evaluations.lcp} (目标: <${formatTime(TARGETS.lcp)})`);
  console.log(`  FCP:  ${formatTime(avgMetrics.fcp).padEnd(10)} ${summary.evaluations.fcp} (目标: <${formatTime(TARGETS.fcp)})`);
  console.log(`  CLS:  ${avgMetrics.cls.toFixed(3).padEnd(10)} ${summary.evaluations.cls} (目标: <${TARGETS.cls})`);
  console.log(`  TBT:  ${formatTime(avgMetrics.tbt).padEnd(10)} ${summary.evaluations.tbt} (目标: <${formatTime(TARGETS.tbt)})`);
  console.log('');
  console.log('其他指标:');
  console.log(`  TTI:  ${formatTime(avgMetrics.tti)}`);
  console.log(`  SI:   ${formatTime(avgMetrics.si)}`);
  console.log(`  TTFB: ${formatTime(avgMetrics.ttfb)}`);
  console.log('');
  console.log('📊 与基线对比 (优化前: LCP=' + formatTime(BASELINE.lcp) + ')');
  console.log(`  LCP 改善: ${formatTime(summary.improvements.lcp)} (${summary.improvements.lcpPercent})`);
  console.log('');
  console.log(`✅ 汇总已保存到: ${OUTPUT_FILE}`);
}

main();
