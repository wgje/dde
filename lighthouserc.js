/**
 * Lighthouse CI 配置
 * 
 * 用于 CI/CD 流水线中的性能监控
 * 
 * 使用方法:
 * 1. 安装: npm install --save-dev @lhci/cli
 * 2. 运行: npx lhci autorun
 * 
 * @see https://github.com/GoogleChrome/lighthouse-ci
 */

module.exports = {
  ci: {
    collect: {
      // 测试 URL
      url: ['http://localhost:4200/'],
      
      // 启动服务器命令
      startServerCommand: 'npx http-server dist/browser -p 4200 -s',
      startServerReadyPattern: 'Available on',
      startServerReadyTimeout: 30000,
      
      // 运行次数（取中位数）
      numberOfRuns: 3,
      
      // Chrome 配置
      settings: {
        chromeFlags: '--no-sandbox --headless --disable-gpu',
        onlyCategories: ['performance'],
      },
    },
    
    assert: {
      // 性能断言
      assertions: {
        // 核心 Web Vitals
        'categories:performance': ['warn', { minScore: 0.85 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 1500 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'first-contentful-paint': ['warn', { maxNumericValue: 1000 }],
        'total-blocking-time': ['warn', { maxNumericValue: 200 }],
        
        // 其他重要指标
        'speed-index': ['warn', { maxNumericValue: 2000 }],
        'interactive': ['warn', { maxNumericValue: 3000 }],
      },
    },
    
    upload: {
      // 使用临时公共存储（免费）
      target: 'temporary-public-storage',
    },
  },
};
