const fs = require('node:fs');
const path = require('node:path');

function writeTextFileIfChanged(filePath, content, options = {}) {
  const encoding = options.encoding || 'utf8';
  const nextContent = String(content);

  try {
    if (fs.readFileSync(filePath, encoding) === nextContent) {
      return false;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, encoding);
  return true;
}

module.exports = {
  writeTextFileIfChanged,
};
