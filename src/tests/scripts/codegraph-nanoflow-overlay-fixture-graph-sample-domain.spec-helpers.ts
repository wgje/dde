type FixtureWriter = (root: string, relativePath: string, content: string) => void;

export function writeCodegraphOverlayDefaultExportFixtureFiles(
  root: string,
  writeFile: FixtureWriter,
): void {
  writeFile(
    root,
    'src/app/features/sample/default-export.ts',
    [
      'export default class DefaultEntity {',
      "  readonly source = 'default';",
      '}',
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    'src/app/features/sample/default-consumer.ts',
    [
      "import DefaultAlias from './default-export';",
      '',
      'export function createDefault(): DefaultAlias {',
      '  return new DefaultAlias();',
      '}',
      '',
    ].join('\n'),
  );
}
