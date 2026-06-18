import { useState } from "react";
import { COMPANY_NAME, login } from "./auth/auth";
import "./Login.css";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden>
          ✦
        </div>
        <h1 className="login-company">{COMPANY_NAME}</h1>
        <p className="login-sub">Excalidraw Sketsa — Silakan Masuk</p>

        <label className="login-field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>

        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button type="submit" className="login-submit">
          Masuk
        </button>

        <p className="login-hint">Demo: admin / mesari123</p>
      </form>

      <footer className="login-foot">
        © {new Date().getFullYear()} {COMPANY_NAME}
      </footer>
    </div>
  );
}
