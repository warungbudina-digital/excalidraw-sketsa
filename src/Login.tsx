import { useState } from "react";
import { COMPANY_NAME, login } from "./auth/auth";
import "./Login.css";

/* Inline SVGs (no image assets, no web fonts) keep the screen light + crisp at any DPI. */

function CctvMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {/* wall mount + camera body */}
      <path d="M5 5v7" />
      <path d="M5 9h4.5" />
      <rect x="9.5" y="6" width="13.5" height="7" rx="2" />
      <circle cx="13" cy="9.5" r="1.6" />
      {/* visor / tail */}
      <path d="M23 7.8l4-1.4v7.2l-4-1.4" />
      {/* network signal waves */}
      <path d="M16 19a7 7 0 0 1 7 7" opacity=".55" />
      <path d="M16 23.5a2.5 2.5 0 0 1 2.5 2.5" opacity=".55" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (login(username.trim(), password)) {
      setError("");
      onSuccess();
    } else {
      setError("Username atau password salah.");
    }
  };

  return (
    <div className="login">
      <main className="login-card">
        <div className="login-brand">
          <div className="login-logo">
            <CctvMark />
          </div>
          <h1 className="login-company">{COMPANY_NAME}</h1>
          <p className="login-tagline">Solusi CCTV &amp; Jaringan</p>
        </div>

        <form className="login-form" onSubmit={submit} noValidate>
          <p className="login-prompt">Masuk untuk melanjutkan</p>

          <label className="login-field">
            <span className="login-label">Username</span>
            <span className="login-input">
              <span className="login-input-icon">
                <UserIcon />
              </span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="admin"
                autoFocus
              />
            </span>
          </label>

          <label className="login-field">
            <span className="login-label">Password</span>
            <span className="login-input">
              <span className="login-input-icon">
                <LockIcon />
              </span>
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "Sembunyikan password" : "Tampilkan password"}
                aria-pressed={showPw}
              >
                <EyeIcon off={showPw} />
              </button>
            </span>
          </label>

          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="login-submit">
            Masuk
          </button>

          <p className="login-hint">
            Demo: <code>admin</code> / <code>mesari123</code>
          </p>
        </form>
      </main>

      <footer className="login-foot">
        © {new Date().getFullYear()} {COMPANY_NAME}
      </footer>
    </div>
  );
}
