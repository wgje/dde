/** 认证结果类型 */
export interface AuthResult {
  userId?: string;
  email?: string;
  needsConfirmation?: boolean;
}
