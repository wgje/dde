import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const root = path.join(process.cwd(), 'public/fonts');
const read = (name: string) => fs.readFileSync(path.join(root, name));
const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(read('lxgw-wenkai-screen-sources.json').toString()) as {
  version: string;
  fonts: { file: string; subset: number; bytes: number; sha256: string; existingLocal: boolean }[];
  licenses: { file: string; bytes: number; sha256: string }[];
};
const supplement = read('lxgw-wenkai-screen-supplement.css').toString();
describe('self-hosted regular font coverage', () => {
  it('pins all 97 upstream regular fonts, preserves the existing 14, and verifies WOFF2 bytes', () => {
    expect(manifest.version).toBe('1.7.0');
    expect(manifest.fonts).toHaveLength(97);
    expect(new Set(manifest.fonts.map(font => font.subset)).size).toBe(97);
    expect(new Set(manifest.fonts.map(font => font.file)).size).toBe(97);
    expect(manifest.fonts.filter(font => font.existingLocal)).toHaveLength(14);
    for (const font of manifest.fonts) {
      expect(font.file).toBe(`lxgwwenkaiscreen-subset-${font.subset}.woff2`);
      const bytes = read(font.file);
      expect(bytes.length).toBe(font.bytes);
      expect(bytes.subarray(0, 4).toString()).toBe('wOF2');
      expect(sha(bytes)).toBe(font.sha256);
    }
    expect(manifest.fonts.reduce((sum, font) => sum + font.bytes, 0)).toBe(5_102_384);
  });
  it('keeps 83 supplemental faces disjoint from local faces and uses no external font source', () => {
    expect(sha(Buffer.from(supplement))).toBe('f415847a08e9fca8f2bc022db3f5710698f8e1de720b9d2dd73351ea3a49cf37');
    const faces = supplement.match(/@font-face\s*\{[^}]+\}/g) ?? [];
    expect(faces).toHaveLength(83);
    const urls = [...supplement.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)].map(m => m[1]);
    expect(urls.slice().sort()).toEqual(manifest.fonts.filter(font => !font.existingLocal).map(font => `/fonts/${font.file}`).sort());
    for (const face of faces) {
      expect(face).toMatch(/font-family:\s*['"]LXGW WenKai Screen['"]/);
      expect(face).toMatch(/font-display:\s*swap/);
      expect(face).toMatch(/font-style:\s*normal/);
      expect(face).toMatch(/font-weight:\s*400/);
      expect(face).toMatch(/unicode-range:\s*U\+/);
    }
    const local = read('lxgw-wenkai-screen.css').toString();
    const localIds = [...local.matchAll(/url\([^)]*subset-(\d+)\.woff2[^)]*\)/g)].map(m => Number(m[1]));
    expect([...new Set(localIds), 119].sort((a, b) => a - b)).toEqual(manifest.fonts.filter(font => font.existingLocal).map(font => font.subset));
  });
  it('ships both redistribution notices and leaves fonts in the lazy worker group', () => {
    expect(manifest.licenses).toHaveLength(2);
    for (const license of manifest.licenses) {
      const bytes = read(license.file);
      expect(bytes.length).toBe(license.bytes);
      expect(sha(bytes)).toBe(license.sha256);
    }
    const config = JSON.parse(fs.readFileSync('ngsw-config.json', 'utf8'));
    const fontGroup = config.assetGroups.find((g: { name: string }) => g.name === 'local-fonts');
    expect(fontGroup.installMode).toBe('lazy');
    expect(fontGroup.updateMode).toBe('lazy');
    expect(fontGroup.resources.files).toContain('/fonts/**');
  });
});
