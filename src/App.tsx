import { useState } from "react";
import Login from "./Login";
import Editor from "./Editor";
import { isAuthenticated, logout } from "./auth/auth";

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated());

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return (
    <Editor
      onLogout={() => {
        logout();
        setAuthed(false);
      }}
    />
  );
}
