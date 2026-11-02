import { afterEach, beforeEach, describe } from './project-data.service.spec-context';
import {
  clearAllOfflineSnapshotsIdb,
  resetBrowserNetworkSuspensionTrackingForTests,
  resetTaskSchemaCompatibilityForTests,
  setVisibilityState,
} from './project-data.service.spec-context';
import { registerProjectDataCloudLoadSpecs } from './project-data-cloud-load.spec-helpers';
import { registerProjectDataOfflineSnapshotSpecs } from './project-data-offline-snapshot.spec-helpers';
import { registerProjectDataMetadataListSpecs } from './project-data-metadata-list.spec-helpers';
import { registerProjectDataTaskRowSpecs } from './project-data-task-row.spec-helpers';

// run-test-matrix scans spec source for DOM tokens; this suite controls document.visibilityState via shared helpers.
describe('ProjectDataService', () => {
  beforeEach(async () => {
    resetTaskSchemaCompatibilityForTests();
    localStorage.clear();
    setVisibilityState('visible');
    await clearAllOfflineSnapshotsIdb();
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
  });

  registerProjectDataCloudLoadSpecs();
  registerProjectDataOfflineSnapshotSpecs();
  registerProjectDataMetadataListSpecs();
  registerProjectDataTaskRowSpecs();
});
