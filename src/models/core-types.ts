/**
 * 鏍稿績涓氬姟绫诲瀷瀹氫箟
 * 
 * 杩欎釜鏂囦欢鍖呭惈鏈€鍩虹鐨勭被鍨嬪畾涔夛紝涓嶄緷璧栦换浣曞叾浠栨ā鍨嬫枃浠躲€? * 鍏朵粬妯″瀷鏂囦欢鍙互浠庤繖閲屽鍏ュ熀纭€绫诲瀷锛岄伩鍏嶅惊鐜緷璧栥€? * 
 * 銆怭2-32 娉ㄦ剰銆憁odels/index.ts 鏄鑼冪殑绫诲瀷婧愬ご锛屾湰鏂囦欢涓烘墦鐮村惊鐜緷璧栬€屽瓨鍦ㄧ殑鍓湰銆? * 淇敼鍨嬪畾涔夋椂锛屽繀椤诲悓姝ユ洿鏂颁袱涓枃浠躲€? */

/**
 * 浠诲姟鐘舵€佹灇涓? * - active: 娲诲姩鐘舵€侊紝姝ｅ湪杩涜涓? * - completed: 宸插畬鎴? * - archived: 宸插綊妗ｏ紝涓嶆樉绀哄湪涓昏鍥句腑浣嗕粛鍙悳绱㈠拰鎭㈠
 */
export type TaskStatus = 'active' | 'completed' | 'archived';

/**
 * 闄勪欢绫诲瀷
 */
export type AttachmentType = 'image' | 'document' | 'link' | 'file';

/**
 * 闄勪欢妯″瀷
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
  /** 杞垹闄ゆ椂闂存埑 銆怭2-32 淇銆戣ˉ鍏呯己澶卞瓧娈碉紝涓?models/index.ts 淇濇寔涓€鑷?*/
  deletedAt?: string;
}

/**
 * 杩炴帴妯″瀷锛堜换鍔′箣闂寸殑鍏宠仈锛? */
export interface Connection {
  id: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  deletedAt?: string | null;
  /** 鏈€鍚庢洿鏂版椂闂存埑锛圠WW 鍐茬獊瑙ｅ喅蹇呴渶锛?*/
  updatedAt?: string;
}

/**
 * 浠诲姟妯″瀷
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


  /**
   * State Overlap 鍋滄硦鍏冩暟鎹?   * 浠?status === 'active' 鐨勪换鍔″彲鎸佹湁姝ゅ瓧娈?   */
  parkingMeta?: import('./parking').TaskParkingMeta | null;
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
  viewState?: ViewState;
  flowchartUrl?: string;
  flowchartThumbnailUrl?: string;
}

/**
 * 瑙嗗浘鐘舵€侊紙鐢ㄤ簬鎸佷箙鍖栨祦绋嬪浘瑙嗗彛浣嶇疆锛? * 銆怭0-11 淇銆戠粺涓€涓?positionX/positionY 鎵佸钩缁撴瀯锛屼笌 models/index.ts 淇濇寔涓€鑷? */
export interface ViewState {
  scale: number;
  positionX: number;
  positionY: number;
}
