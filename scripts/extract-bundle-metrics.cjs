/**
 * Bundle 指标提取脚本
 * 从 source-map-explorer JSON 报告中提取关键指标
 * 
 * 用法: node scripts/extract-bundle-metrics.cjs
 */

const fs = require('fs');
const path = require('path');

const ANALYSIS_DIR = path.join(__dirname, '..', 'dist', 'analysis');
const MAIN_REPORT = path.join(ANALYSIS_DIR, 'main-bundle-report.json');
const FULL_REPORT = path.join(ANALYSIS_DIR, 'full-bundle-report.json');
const OUTPUT_FILE = path.join(ANALYSIS_DIR, 'bundle-metrics.json');

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 提取依赖大小
 */
function extractDependencies(data) {
  const deps = {};
  
  function traverse(node, prefix = '') {
    if (!node) return;
    
    // 检查是否为 node_modules 包
    if (prefix.includes('node_modules/')) {
      const match = prefix.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
      if (match) {
        const pkgName = match[1];
        deps[pkgName] = (deps[pkgName] || 0) + (node.size || 0);
      }
    }
    
    // 递归遍历子节点
    if (node.groups) {
      for (const [key, child] of Object.entries(node.groups)) {
        traverse(child, prefix + key + '/');
      }
    }
  }
  
  if (data.results) {
    for (const result of data.results) {
      traverse(result.files, '');
    }
  }
  
  return deps;
}

/**
 * 主函数
 */
function main() {
  console.log('📊 提取 Bundle 指标...');
  
  const metrics = {
    timestamp: new Date().toISOString(),
    bundles: {},
    dependencies: {},
    summary: {
      totalSize: 0,
      mainBundleSize: 0,
      largestDependencies: [],
    }
  };
  
  // 读取主包报告
  if (fs.existsSync(MAIN_REPORT)) {
    try {
      const data = JSON.parse(fs.readFileSync(MAIN_REPORT, 'utf8'));
      if (data.results && data.results[0]) {
        const result = data.results[0];
        metrics.bundles.main = {
          totalBytes: result.totalBytes || 0,
          formatted: formatSize(result.totalBytes || 0),
        };
        metrics.summary.mainBundleSize = result.totalBytes || 0;
        metrics.dependencies = extractDependencies(data);
      }
    } catch (e) {
      console.warn('⚠️ 无法解析 main bundle 报告:', e.message);
    }
  }
  
  // 读取全部包报告
  if (fs.existsSync(FULL_REPORT)) {
    try {
      const data = JSON.parse(fs.readFileSync(FULL_REPORT, 'utf8'));
      let totalSize = 0;
      
      if (data.results) {
        data.results.forEach((result, index) => {
          const bundleName = result.bundleName || `bundle-${index}`;
          metrics.bundles[bundleName] = {
            totalBytes: result.totalBytes || 0,
            formatted: formatSize(result.totalBytes || 0),
          };
          totalSize += result.totalBytes || 0;
        });
      }
      
      metrics.summary.totalSize = totalSize;
      metrics.summary.totalFormatted = formatSize(totalSize);
    } catch (e) {
      console.warn('⚠️ 无法解析 full bundle 报告:', e.message);
    }
  }
  
  // 找出最大的依赖
  const sortedDeps = Object.entries(metrics.dependencies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  metrics.summary.largestDependencies = sortedDeps.map(([name, size]) => ({
    name,
    size,
    formatted: formatSize(size),
    percentage: metrics.summary.totalSize > 0 
      ? ((size / metrics.summary.totalSize) * 100).toFixed(2) + '%'
      : '0%'
  }));
  
  // 确保目录存在
  if (!fs.existsSync(ANALYSIS_DIR)) {
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  }
  
  // 写入指标文件
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metrics, null, 2));
  
  // 输出汇总
  console.log('\n📈 Bundle 指标汇总:');
  console.log('========================');
  console.log(`总大小: ${metrics.summary.totalFormatted || 'N/A'}`);
  console.log(`Main Bundle: ${metrics.bundles.main?.formatted || 'N/A'}`);
  console.log('\n🏆 最大依赖 Top 5:');
  metrics.summary.largestDependencies.slice(0, 5).forEach((dep, i) => {
    console.log(`  ${i + 1}. ${dep.name}: ${dep.formatted} (${dep.percentage})`);
  });
  
  console.log(`\n✅ 指标已保存到: ${OUTPUT_FILE}`);
}

main();
