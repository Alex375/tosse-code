// Réglages → Comptes : the in-app login/logout/status for BOTH backends. Each
// backend gets a group card: who is signed in (email · plan), and the connect /
// disconnect actions. The flows drive the OFFICIAL mechanisms only —
// `claude auth login|logout` for Claude (URL + pasted code) and the app-server's
// `account/login/*` for Codex (URL + async `account_login` completion event) — the
// app never touches a credential store itself. Every failure surfaces inline.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { events } from "../../ipc/client";
import {
  useClaudeAccount,
  useClaudeAccountActions,
  useCodexAccount,
  useCodexAccountActions,
} from "../../ipc/useAccounts";
import { useCodexAvailable } from "../../store/codexAvailable";
import { ClaudeMark, CodexMark } from "../../ui/kit";
import { PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function AccountsSection() {
  const codexAvailable = useCodexAvailable();
  return (
    <div>
      <PageHead
        title="Comptes"
        subtitle="Connexion aux comptes Claude et Codex utilisés par les agents."
      />
      <ClaudeAccountGroup />
      {codexAvailable ? (
        <CodexAccountGroup />
      ) : (
        <SettingsGroup title="Codex" icon="key">
          <ToggleRow
            title="CLI Codex introuvable"
            hint="Installe le binaire codex (npm i -g @openai/codex) pour connecter un compte."
            control={<span />}
          />
        </SettingsGroup>
      )}
    </div>
  );
}

/** One-line status text for a group row. */
function statusHint(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function ClaudeAccountGroup() {
  const status = useClaudeAccount(true);
  const { loginStart, loginCode, loginCancel, logout } = useClaudeAccountActions();
  // The two-step login: null = idle; "code" = URL opened, waiting for the pasted code.
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const err =
    (loginStart.error as Error | null)?.message ??
    (loginCode.error as Error | null)?.message ??
    (logout.error as Error | null)?.message ??
    null;

  const startLogin = () => {
    loginStart.mutate(undefined, {
      onSuccess: (url) => {
        setStep("code");
        setCode("");
        void openUrl(url);
      },
    });
  };
  const submitCode = () => {
    if (!code.trim()) return;
    loginCode.mutate(code, {
      onSuccess: () => {
        setStep("idle");
        setCode("");
      },
      // On failure the CLI child has exited: back to idle so "Se connecter" restarts
      // a fresh flow (the error stays visible below).
      onError: () => setStep("idle"),
    });
  };
  const cancelLogin = () => {
    loginCancel.mutate(undefined, { onSettled: () => setStep("idle") });
  };

  const logged = status.data?.loggedIn === true;
  return (
    <SettingsGroup title="Claude" icon="key">
      <ToggleRow
        title={
          status.isLoading
            ? "Vérification du compte…"
            : logged
              ? (status.data?.email ?? "Connecté")
              : "Non connecté"
        }
        hint={
          status.isError
            ? `Statut indisponible : ${(status.error as Error).message}`
            : logged
              ? statusHint([
                  status.data?.subscriptionType ? `forfait ${status.data.subscriptionType}` : null,
                  status.data?.orgName,
                ])
              : "Connecte le compte Anthropic que le CLI claude utilisera."
        }
        control={
          logged ? (
            confirmingLogout ? (
              <span className={styles.row}>
                <button
                  className={`${styles.btn} ${styles.danger}`}
                  disabled={logout.isPending}
                  onClick={() =>
                    logout.mutate(undefined, { onSettled: () => setConfirmingLogout(false) })
                  }
                >
                  {logout.isPending ? "Déconnexion…" : "Confirmer"}
                </button>
                <button
                  className={`${styles.btn} ${styles.ghost}`}
                  disabled={logout.isPending}
                  onClick={() => setConfirmingLogout(false)}
                >
                  Annuler
                </button>
              </span>
            ) : (
              <button className={`${styles.btn} ${styles.ghost}`} onClick={() => setConfirmingLogout(true)}>
                Se déconnecter…
              </button>
            )
          ) : step === "idle" ? (
            <button className={styles.btn} disabled={loginStart.isPending} onClick={startLogin}>
              <ClaudeMark className="sm" /> {loginStart.isPending ? "Ouverture…" : "Se connecter"}
            </button>
          ) : (
            <span />
          )
        }
      />
      {step === "code" ? (
        <ToggleRow
          title="Colle le code d'autorisation"
          hint="Autorise dans le navigateur, copie le code affiché, puis colle-le ici."
          control={
            <span className={styles.row}>
              <input
                className={styles.codeInput}
                value={code}
                autoFocus
                placeholder="Code…"
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCode();
                }}
              />
              <button
                className={styles.btn}
                disabled={!code.trim() || loginCode.isPending}
                onClick={submitCode}
              >
                {loginCode.isPending ? "Validation…" : "Valider"}
              </button>
              <button
                className={`${styles.btn} ${styles.ghost}`}
                disabled={loginCode.isPending}
                onClick={cancelLogin}
              >
                Annuler
              </button>
            </span>
          }
        />
      ) : null}
      {err ? <div className={styles.accountErr}>{err}</div> : null}
    </SettingsGroup>
  );
}

function CodexAccountGroup() {
  const status = useCodexAccount(true);
  const { loginStart, loginCancel, logout } = useCodexAccountActions();
  // "waiting" = URL opened, the dedicated app-server is holding the OAuth callback;
  // the outcome arrives as the app-global `account_login` event.
  const [waiting, setWaiting] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [confirmingLogout, setConfirmingLogout] = useState(false);

  useEffect(() => {
    let disposed = false;
    const un = events.accountLoginEvent.listen((e) => {
      if (disposed || e.payload.backend !== "codex") return;
      setWaiting(false);
      setLoginErr(e.payload.success ? null : (e.payload.error ?? "la connexion a échoué"));
    });
    return () => {
      disposed = true;
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  const err =
    loginErr ??
    (loginStart.error as Error | null)?.message ??
    (logout.error as Error | null)?.message ??
    null;
  const startLogin = () => {
    setLoginErr(null);
    loginStart.mutate(undefined, {
      onSuccess: (res) => {
        setWaiting(true);
        void openUrl(res.authUrl);
      },
    });
  };
  const cancelLogin = () => {
    loginCancel.mutate(undefined, { onSettled: () => setWaiting(false) });
  };

  const logged = status.data?.loggedIn === true;
  return (
    <SettingsGroup title="Codex" icon="key">
      <ToggleRow
        title={
          status.isLoading
            ? "Vérification du compte…"
            : logged
              ? (status.data?.email ?? "Connecté")
              : "Non connecté"
        }
        hint={
          status.isError
            ? `Statut indisponible : ${(status.error as Error).message}`
            : logged
              ? statusHint([
                  status.data?.planType ? `forfait ${status.data.planType}` : null,
                  status.data?.authMethod === "chatgpt" ? "compte ChatGPT" : status.data?.authMethod,
                ])
              : "Connecte le compte ChatGPT que le CLI codex utilisera."
        }
        control={
          logged ? (
            confirmingLogout ? (
              <span className={styles.row}>
                <button
                  className={`${styles.btn} ${styles.danger}`}
                  disabled={logout.isPending}
                  onClick={() =>
                    logout.mutate(undefined, { onSettled: () => setConfirmingLogout(false) })
                  }
                >
                  {logout.isPending ? "Déconnexion…" : "Confirmer"}
                </button>
                <button
                  className={`${styles.btn} ${styles.ghost}`}
                  disabled={logout.isPending}
                  onClick={() => setConfirmingLogout(false)}
                >
                  Annuler
                </button>
              </span>
            ) : (
              <button className={`${styles.btn} ${styles.ghost}`} onClick={() => setConfirmingLogout(true)}>
                Se déconnecter…
              </button>
            )
          ) : waiting ? (
            <span className={styles.row}>
              <span className={styles.waitingHint}>Autorise dans le navigateur…</span>
              <button className={`${styles.btn} ${styles.ghost}`} onClick={cancelLogin}>
                Annuler
              </button>
            </span>
          ) : (
            <button className={styles.btn} disabled={loginStart.isPending} onClick={startLogin}>
              <CodexMark className="sm" /> {loginStart.isPending ? "Ouverture…" : "Se connecter"}
            </button>
          )
        }
      />
      {err ? <div className={styles.accountErr}>{err}</div> : null}
    </SettingsGroup>
  );
}
