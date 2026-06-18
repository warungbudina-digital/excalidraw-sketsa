/**
 * Minimal client-side login gate.
 *
 * NOTE: this is a front-end gate only — there is no backend, so it is NOT real security
 * (anyone can bypass it via devtools). It exists to brand the app and keep casual access
 * behind a login screen. For real auth, move the check to a server.
 */

export const COMPANY_NAME = "Mesari Jaya Network dan CCTV";

const AUTH_KEY = "excalidraw-sketsa:auth";

// Demo credentials. Change these (or wire to a real backend) before any real use.
const VALID_USERNAME = "admin";
const VALID_PASSWORD = "mesari123";

export function isAuthenticated(): boolean {
  return sessionStorage.getItem(AUTH_KEY) === "1";
}

export function login(username: string, password: string): boolean {
  if (username === VALID_USERNAME && password === VALID_PASSWORD) {
    sessionStorage.setItem(AUTH_KEY, "1");
    return true;
  }
  return false;
}

export function logout(): void {
  sessionStorage.removeItem(AUTH_KEY);
}
