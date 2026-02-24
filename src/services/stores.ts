/**
 * 状态 Store 服务的重导出桥接
 *
 * services/ 层通过此文件引用 Store 类，满足分层架构 lint 规则
 * （services/ 层不直接引用 app/core/ 层）
 */

// eslint-disable-next-line no-restricted-imports
export { TaskStore, ProjectStore, ConnectionStore } from '../app/core/state/stores';
