const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const DEFAULT_RELATIONS = [
  'delegate_permission/common.handle_all_urls',
  'delegate_permission/common.use_as_origin',
];

const OUTPUT_PATH = path.resolve(__dirname, '../public/.well-known/assetlinks.json');
const LOCAL_ENV = dotenv.config({ path: path.resolve(__dirname, '../.env.local') }).parsed || {};

function trimToNull(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveEnvValue(keys, env = process.env, localEnv = LOCAL_ENV) {
  for (const key of keys) {
    const value = trimToNull(env[key] ?? localEnv[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function normalizePackageName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(trimmed)
    ? trimmed
    : null;
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const compact = trimmed.replace(/[:\-\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(compact)) {
    return null;
  }

  return compact.match(/.{2}/g).join(':');
}

function parseListLikeValue(raw) {
  const normalized = trimToNull(raw);
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed.map(value => String(value));
      }
    } catch {
      return [];
    }
  }

  return normalized.split(/[\r\n,;]+/);
}

function parseFingerprintList(raw) {
  return [...new Set(parseListLikeValue(raw)
    .map(normalizeFingerprint)
    .filter(Boolean))];
}

function parseRelations(raw) {
  const parsed = [...new Set(parseListLikeValue(raw)
    .map(value => value.trim())
    .filter(value => value.length > 0))];

  return parsed.length > 0 ? parsed : [...DEFAULT_RELATIONS];
}

function resolveAssetLinksConfig(env = process.env, localEnv = LOCAL_ENV) {
  const packageNameRaw = resolveEnvValue([
    'ANDROID_TWA_PACKAGE_NAME',
    'NG_APP_ANDROID_TWA_PACKAGE_NAME',
  ], env, localEnv);
  const fingerprintsRaw = resolveEnvValue([
    'ANDROID_TWA_SHA256_CERT_FINGERPRINTS',
    'NG_APP_ANDROID_TWA_SHA256_CERT_FINGERPRINTS',
  ], env, localEnv);
  const relationsRaw = resolveEnvValue([
    'ANDROID_TWA_RELATIONS',
    'NG_APP_ANDROID_TWA_RELATIONS',
  ], env, localEnv);

  return {
    packageNameRaw,
    packageName: normalizePackageName(packageNameRaw),
    fingerprintsRaw,
    fingerprints: parseFingerprintList(fingerprintsRaw),
    relationsRaw,
    relations: parseRelations(relationsRaw),
  };
}

function buildAssetLinksDocument(config) {
  if (!config.packageName) {
    throw new Error('ANDROID_TWA_PACKAGE_NAME is missing or invalid');
  }

  if (!Array.isArray(config.fingerprints) || config.fingerprints.length === 0) {
    throw new Error('ANDROID_TWA_SHA256_CERT_FINGERPRINTS is missing or invalid');
  }

  return [
    {
      relation: config.relations && config.relations.length > 0
        ? config.relations
        : [...DEFAULT_RELATIONS],
      target: {
        namespace: 'android_app',
        package_name: config.packageName,
        sha256_cert_fingerprints: config.fingerprints,
      },
    },
  ];
}

function removeFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.rmSync(filePath);
  return true;
}

function syncAssetLinksFile(config, outputPath = OUTPUT_PATH) {
  if (config.packageNameRaw && !config.packageName) {
    throw new Error('ANDROID_TWA_PACKAGE_NAME is invalid');
  }

  if (config.fingerprintsRaw && config.fingerprints.length === 0) {
    throw new Error('ANDROID_TWA_SHA256_CERT_FINGERPRINTS is invalid');
  }

  if (!config.packageName || config.fingerprints.length === 0) {
    const removedStaleFile = removeFileIfExists(outputPath);
    return {
      ready: false,
      outputPath,
      removedStaleFile,
      reason: !config.packageName ? 'missing-package-name' : 'missing-cert-fingerprints',
    };
  }

  const document = buildAssetLinksDocument(config);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  return {
    ready: true,
    outputPath,
    packageName: config.packageName,
    fingerprintCount: config.fingerprints.length,
    relations: document[0].relation,
  };
}

function main() {
  const config = resolveAssetLinksConfig();
  const result = syncAssetLinksFile(config);

  if (!result.ready) {
    console.log(`ℹ️ Android assetlinks 未生成（${result.reason}）`);
    if (result.removedStaleFile) {
      console.log(`   已移除旧文件: ${result.outputPath}`);
    }
    return;
  }

  console.log('✅ Android assetlinks 已生成');
  console.log(`   - 输出: ${result.outputPath}`);
  console.log(`   - package: ${result.packageName}`);
  console.log(`   - fingerprints: ${result.fingerprintCount}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_RELATIONS,
  OUTPUT_PATH,
  buildAssetLinksDocument,
  normalizeFingerprint,
  parseFingerprintList,
  parseRelations,
  resolveAssetLinksConfig,
  syncAssetLinksFile,
};
