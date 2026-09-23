export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  last_login_at?: string | null;
}

export interface AuthSession {
  user: AuthUser;
  expires_at: string | null;
}

export interface AuthStatus {
  enabled: boolean;
  mode: string;
  attribute_lookup: string;
  encrypted_transport: boolean;
  cookie_secure: boolean;
  trust_proxy: boolean;
  session_ttl_ms: number;
  session_absolute_ttl_ms: number;
  allowlist: {
    mode: "disabled" | "enabled";
    enforced: boolean;
    path: string | null;
    size: number;
    last_loaded_at: string | null;
    reload_ms: number;
    last_error: string | null;
  };
}

export function readErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

export function isUnauthorizedError(error: unknown): boolean {
  const code = readErrorCode(error);
  return code === "authentication_required" || code === "session_expired";
}

export function authErrorMessage(error: unknown): string {
  const code = readErrorCode(error);
  switch (code) {
    case "invalid_credentials":
      return "账号或密码不正确";
    case "account_not_authorized":
      return "该账号未获授权使用本系统，请联系管理员加入白名单";
    case "account_disabled":
      return "该账号已被停用";
    case "auth_rate_limited":
      return "登录尝试过于频繁，请稍后再试";
    case "auth_backend_unavailable":
      return "账号服务暂时不可用，请稍后重试或联系 IT";
    case "validation_error":
      return "请输入账号和密码";
    default:
      return error instanceof Error && error.message ? error.message : "登录失败，请重试";
  }
}
