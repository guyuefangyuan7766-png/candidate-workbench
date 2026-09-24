import { useEffect, useRef, useState } from "react";
import { Loader2, LogIn, ShieldCheck } from "lucide-react";
import { login } from "../api";
import { authErrorMessage, type AuthUser } from "../auth";

export interface LoginPageProps {
  onSuccess: (user: AuthUser) => void;
  notice?: string;
}

export function LoginPage({ onSuccess, notice }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const usernameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const session = await login(username.trim(), password);
      setPassword("");
      onSuccess(session.user);
    } catch (failure) {
      setError(authErrorMessage(failure));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tw-login">
      <form className="tw-login-card" onSubmit={submit}>
        <span className="tw-login-mark">
          <strong>拾才</strong>
          <small>让优秀的人更容易被看见</small>
        </span>
        <div className="tw-login-head">
          <h1>登录拾才工作台</h1>
          <p>使用公司 LDAP 账号登录，密码由公司统一管理。</p>
        </div>
        {notice && <p className="tw-login-notice" role="status">{notice}</p>}
        <label className="tw-login-field">
          <span>账号</span>
          <input
            ref={usernameRef}
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="例如 zhangsan"
          />
        </label>
        <label className="tw-login-field">
          <span>密码</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p className="tw-login-error" role="alert">{error}</p>
        )}
        <button className="tw-login-submit" type="submit" disabled={!canSubmit}>
          {busy ? <Loader2 className="tw-login-spin" size={16} /> : <LogIn size={16} />}
          {busy ? "正在验证…" : "登录"}
        </button>
        <p className="tw-login-foot">
          <ShieldCheck size={13} aria-hidden="true" />
          仅限已授权账号访问，所有操作记录在服务器本机
        </p>
      </form>
    </div>
  );
}

