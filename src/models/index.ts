// ============================================
// NanoFlow 鏁版嵁妯″瀷瀹氫箟
// ============================================

/**
 * Task status enum.
 */
export type TaskStatus = 'active' | 'completed' | 'archived';

/**
 * Attachment type enum.
 */
export type AttachmentType = 'image' | 'document' | 'link' | 'file';

/**
 * Attachment model.
 */
export interface Attachment {
  id: string;
  type: AttachmentType;
  name: string;
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
  size?: number;
  createdAt: string;
  signedAt?: string;
  deletedAt?: string;
}

/**
 * Task model.
 */
export interface Task {
  id: string;
  title: string;
  content: string;
  stage: number | null;
  parentId: string | null;
  order: number;
  rank: number;
  status: TaskStatus;
  x: number;
  y: number;
  createdDate: string;
  updatedAt?: string;
  displayId: string;
  shortId?: string;
  hasIncompleteTask?: boolean;
  deletedAt?: string | null;

  // Client-only restore metadata (not persisted as task columns).
  deletedConnections?: Connection[];
  deletedMeta?: {
    parentId: string | null;
    stage: number | null;
    order: number;
    rank: number;
    x: number;
    y: number;
  };

  attachments?: Attachment[];
  tags?: string[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';

  dueDate?: string | null;

  // Dock planning attributes (nullable by design)
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;

  // Dock/parking metadata for active task overlays.
  parkingMeta?: import('./parking').TaskParkingMeta | null;
}

/**
 * 杩炴帴妯″瀷锛堜换鍔′箣闂寸殑鍏宠仈锛? */
export interface Connection {
  /** 杩炴帴鐨勫敮涓€鏍囪瘑绗︼紙蹇呴渶锛岀敤浜庡悓姝ュ拰鎭㈠锛?*/
  id: string;
  source: string;
  target: string;
  /** 鑱旂郴鍧楁爣棰橈紙澶栨樉鍐呭锛岀被浼肩淮鍩虹櫨绉戠殑棰勮鏍囬锛?*/
  title?: string;
  /** 鑱旂郴鍧楄缁嗘弿杩帮紙鎮仠/鐐瑰嚮鏃舵樉绀猴級 */
  description?: string;
  /** 杞垹闄ゆ椂闂存埑锛屽瓨鍦ㄨ〃绀哄凡鏍囪鍒犻櫎锛岀瓑寰呮仮澶嶆垨姘镐箙鍒犻櫎 */
  deletedAt?: string | null;
  /** 鏈€鍚庢洿鏂版椂闂存埑 */
  updatedAt?: string;
}

/**
 * 椤圭洰妯″瀷
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt?: string;
  version?: number;
  /** Sync source marker for local-only vs cloud-linked project. */
  syncSource?: 'local-only' | 'synced';
  /** Whether there are unsynced local changes. */
  pendingSync?: boolean;
  viewState?: ViewState;
  flowchartUrl?: string;
  flowchartThumbnailUrl?: string;
}

/**
 * 瑙嗗浘鐘舵€侊紙鐢ㄤ簬鎸佷箙鍖栨祦绋嬪浘瑙嗗彛浣嶇疆锛? */
export interface ViewState {
  scale: number; // 缂╂斁姣斾緥
  positionX: number; // 瑙嗗彛 X 浣嶇疆
  positionY: number; // 瑙嗗彛 Y 浣嶇疆
}

/**
 * 鏈畬鎴愰」鐩ā鍨嬶紙寰呭姙浜嬮」锛? */
export interface UnfinishedItem {
  taskId: string;
  taskDisplayId: string;
  text: string;
}

/**
 * 鐢ㄦ埛鍋忓ソ璁剧疆
 */
export interface UserPreferences {
  theme: ThemeType;
  /** 棰滆壊妯″紡锛堜簯绔粯璁ゅ€硷紝鏈湴鍙鐩栵級 */
  colorMode?: ColorMode;
  layoutDirection: 'ltr' | 'rtl';
  floatingWindowPref: 'auto' | 'fixed';
  /** 
   * 鑷姩瑙ｅ喅鍐茬獊寮€鍏?   * true: 浣跨敤 LWW (Last-Write-Wins) 鑷姩瑙ｅ喅鍐茬獊
   * false: 鎵€鏈夊啿绐佽繘鍏ヤ华琛ㄧ洏鐢辩敤鎴锋墜鍔ㄥ鐞?   */
  autoResolveConflicts?: boolean;
  /**
   * 鏈湴鑷姩澶囦唤寮€鍏?   * 浠呭悓姝ュ紑鍏崇姸鎬侊紝鐩綍璺緞涓嶅悓姝ワ紙涓嶅悓璁惧璺緞涓嶅悓锛?   */
  localBackupEnabled?: boolean;
  /**
   * 鏈湴鑷姩澶囦唤闂撮殧锛堟绉掞級
   */
  localBackupIntervalMs?: number;
  /**
   * 涓撴敞妯″紡鍋忓ソ璁剧疆锛堣法璁惧鍚屾锛?   */
  focusPreferences?: import('./focus').FocusPreferences;
  /**
   * 鍋滄硦鍧?v3 蹇収锛堣法璁惧鍚屾锛屽叏灞€璧勬簮姹狅級
   */
  dockSnapshot?: import('./parking-dock').DockSnapshot;
}

/**
 * 涓婚绫诲瀷锛堣壊璋冿級
 */
export type ThemeType = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/**
 * 棰滆壊妯″紡锛堟槑鏆楋級
 * - light: 娴呰壊妯″紡
 * - dark: 娣辫壊妯″紡  
 * - system: 璺熼殢绯荤粺璁剧疆
 */
export type ColorMode = 'light' | 'dark' | 'system';

/**
 * Supabase 椤圭洰琛屾暟鎹粨鏋? * 鏀寔 v1 (JSONB) 鍜?v2 (鐙珛琛? 涓ょ鏍煎紡
 */
export interface ProjectRow {
  id: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  updated_at?: string | null;
  version?: number;
  /** v1 鏍煎紡: 瀛樺偍 tasks 鍜?connections 鐨?JSONB 鍒?*/
  data?: {
    tasks?: Task[];
    connections?: Connection[];
    version?: number;
  } | null;
  /** v2 鏍煎紡: 鏍囪鏄惁宸茶縼绉诲埌鐙珛琛?*/
  migrated_to_v2?: boolean;
}

/**
 * 鍚屾鐘舵€? */
export interface SyncState {
  isSyncing: boolean;
  isOnline: boolean;
  offlineMode: boolean;
  sessionExpired: boolean;
  syncError: string | null;
  hasConflict: boolean;
  conflictData: { 
    local: Project; 
    /** 鍐茬獊鏃剁殑杩滅▼椤圭洰鏁版嵁 */
    remote: Project;
    projectId: string;
  } | null;
}

/**
 * 鎾ら攢/閲嶅仛鎿嶄綔绫诲瀷
 */
export type UndoActionType = 
  | 'task-create'
  | 'task-delete'
  | 'task-update'
  | 'task-move'
  | 'task-park'
  | 'connection-create'
  | 'connection-delete'
  | 'connection-update'
  | 'project-update';

/**
 * 鎾ら攢/閲嶅仛鎿嶄綔璁板綍
 */
export interface UndoAction {
  type: UndoActionType;
  timestamp: number;
  projectId: string;
  /** 璁板綍鎿嶄綔鏃剁殑椤圭洰鐗堟湰鍙凤紝鐢ㄤ簬妫€娴嬭繙绋嬫洿鏂板啿绐?*/
  projectVersion?: number;
  data: {
    before: Partial<Project>;
    after: Partial<Project>;
  };
}

// ============================================
// 鍚屾鐩稿叧绫诲瀷瀹氫箟
// ============================================

/**
 * 鍚屾妯″紡
 * - automatic: 鑷姩妯″紡 - 鎸夐棿闅旇嚜鍔ㄥ悓姝? * - manual: 鎵嬪姩妯″紡 - 浠呭湪鐢ㄦ埛鎵嬪姩瑙﹀彂鎴栧簲鐢ㄥ惎鍔?閫€鍑烘椂鍚屾
 * - completely-manual: 瀹屽叏鎵嬪姩妯″紡 - 鐢ㄦ埛蹇呴』鏄庣‘閫夋嫨"涓婁紶"鎴?涓嬭浇"
 */
export type SyncMode = 'automatic' | 'manual' | 'completely-manual';

/**
 * 鍚屾鏂瑰悜
 */
export type SyncDirection = 'upload' | 'download' | 'both';

/**
 * 璁惧淇℃伅
 */
export interface DeviceInfo {
  /** 璁惧鍞竴ID */
  deviceId: string;
  /** 璁惧鍚嶇О */
  deviceName: string;
  /** 鎿嶄綔绯荤粺 */
  os: string;
  /** 搴旂敤鐗堟湰 */
  version: string;
  /** 鏈€鍚庢椿璺冩椂闂?*/
  lastSeen: number;
}

/**
 * 鍚屾鐘舵€佹墿灞? */
export interface ExtendedSyncState extends SyncState {
  /** 鍚屾妯″紡 */
  mode: SyncMode;
  /** 鏄惁鍚敤鎰熺煡 */
  perceptionEnabled: boolean;
  /** 鍦ㄧ嚎璁惧鏁伴噺 */
  onlineDeviceCount: number;
  /** 鏈€鍚庡悓姝ユ椂闂?*/
  lastSyncAt: number | null;
  /** 涓嬫鑷姩鍚屾鏃堕棿锛堜粎鑷姩妯″紡锛?*/
  nextSyncAt: number | null;
}

/**
 * 鍐茬獊鍘熷洜
 */
export type ConflictReason = 
  | 'version_mismatch'
  | 'concurrent_edit'
  | 'network_recovery'
  | 'status_conflict'
  | 'field_conflict'
  | 'merge_conflict';

/**
 * 瑙ｅ喅绛栫暐
 */
export type ResolutionStrategy = 
  | 'use_local'
  | 'use_remote'
  | 'merge'
  | 'manual'
  | 'auto_rebase';

// ============================================
// GoJS 杈圭晫绫诲瀷瀵煎嚭
// ============================================
// 銆愭€ц兘浼樺寲 2026-02-07銆戠Щ闄?barrel export锛岄槻姝?GoJS ~800KB 琚媺鍏?main bundle
// GoJS 杩愯鏃跺嚱鏁板凡杩佺Щ鍒?src/app/features/flow/types/gojs-runtime.ts
// 绾被鍨嬫帴鍙ｄ繚鐣欏湪 gojs-boundary.ts锛堟棤 GoJS 杩愯鏃朵緷璧栵級
// 闇€瑕佷娇鐢ㄦ椂璇风洿鎺?import from './gojs-boundary' 鎴栧搴?flow 鐩綍鏂囦欢

// ============================================
// 娴佺▼鍥捐鍥剧姸鎬佸鍑?// ============================================
export * from './flow-view-state';

// ============================================
// Focus Mode 绫诲瀷瀵煎嚭
// ============================================
export * from './focus';

// ============================================
// State Overlap / Parking 绫诲瀷瀵煎嚭
// ============================================
export * from './parking';

// ============================================
// 鍋滄硦鍧?v2 鈥?涓绘帶鍙?+ 闆疯揪 + 鐘舵€佹満
// ============================================
export * from './parking-dock';

// ============================================
// API 绫诲瀷瀹氫箟锛堣竟澧冮槻寰★級
// 娉ㄦ剰锛歛pi-types.ts 涓殑绫诲瀷褰撳墠鏈浣跨敤
// 濡傞渶绫诲瀷瀹堝崼鍔熻兘锛屽彲浠?'./api-types' 鐩存帴瀵煎叆
// ============================================

// ============================================
// Supabase 鏄犲皠鍣紙浠呬緵 Service 灞備娇鐢級
// ============================================
// 娉ㄦ剰锛歴upabase-mapper.ts 涓殑鏄犲皠鍑芥暟褰撳墠鏈浣跨敤
// simple-sync.service.ts 鏈夎嚜宸辩殑绉佹湁 mapper 鏂规硶
// 濡傞渶缁熶竴鏄犲皠閫昏緫锛屽彲浠?'./supabase-mapper' 鐩存帴瀵煎叆
// supabase-types.ts 涓嶅湪姝ゅ鍑猴紝搴旂洿鎺?import from './supabase-types'
