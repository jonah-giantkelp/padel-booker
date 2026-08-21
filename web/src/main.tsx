import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Login from "./Login";
import { api } from "./api";
import "./styles.css";

function Root() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => { api.authStatus().then((result) => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false)); }, []);
  if (authenticated === null) return <div className="auth-loading"><div className="login-mark"><i /><i /><i /></div></div>;
  return authenticated ? <App /> : <Login onSuccess={() => setAuthenticated(true)} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
