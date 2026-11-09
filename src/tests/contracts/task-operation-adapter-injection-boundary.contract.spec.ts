import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('TaskOperationAdapterService injection boundary', () => {
  it('交互入口不得在构造期直接解析 TaskOperationAdapterService', () => {
    const interactionFiles = [
      'src/app/shared/modals/trash-modal.component.ts',
      'src/services/attachment-import.service.ts',
      'src/app/features/flow/components/flow-palette.component.ts',
      'src/app/features/flow/components/flow-task-detail.component.ts',
      'src/app/features/flow/components/flow-view.component.ts',
      'src/app/features/flow/components/mobile-black-box-drawer.component.ts',
      'src/app/features/flow/services/flow-cascade-assign.service.ts',
      'src/app/features/flow/services/flow-diagram-data.service.ts',
      'src/app/features/flow/services/flow-drag-drop.service.ts',
      'src/app/features/flow/services/flow-event-registration.service.ts',
      'src/app/features/flow/services/flow-keyboard.service.ts',
      'src/app/features/flow/services/flow-layout.service.ts',
      'src/app/features/flow/services/flow-link-relink.service.ts',
      'src/app/features/flow/services/flow-link.service.ts',
      'src/app/features/flow/services/flow-task-operations.service.ts',
    ];

    for (const file of interactionFiles) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8');
      expect(source, file).not.toMatch(/inject\s*\(\s*TaskOperationAdapterService\s*\)/);
    }
  });
});
