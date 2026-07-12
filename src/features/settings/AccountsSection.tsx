// Réglages → Comptes : the in-app login/logout/status for BOTH backends, as graphical
// per-backend cards (brand accent, mark tile, live status chip, rich connected state).
// The flows drive the OFFICIAL mechanisms only — `claude auth login|logout` for Claude
// (URL + pasted code) and the app-server's `account/login/*` for Codex (URL + async
// `account_login` completion event) — the app never touches a credential store itself.
// Every failure surfaces inline.
import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { events } from "../../ipc/client";
import {
  useClaudeAccount,
  useClaudeAccountActions,
  useCodexAccount,
  useCodexAccountActions,
} from "../../ipc/useAccounts";
import { useCodexAvailable } from "../../store/codexAvailable";
import { useAccountLoginStore } from "../../store/accountLogin";
import { ClaudeMark, CodexMark } from "../../ui/kit";
import { PageHead } from "./SettingsKit";
import s from "./AccountsSection.module.css";

// The brand accent each card is themed with (drives the glow, tile, plan pill, CTA).
// Shared design tokens (conductor-wirekit.css), never raw hex — so a brand tweak is
// one edit and the Comptes card / Extensions tab / Forfait pill never diverge.
const BRAND: Record<"claude" | "codex", string> = {
  claude: "var(--wf-accent)", // coral
  codex: "var(--wf-codex-accent)", // OpenAI green
};

export function AccountsSection() {
  const codexAvailable = useCodexAvailable();
  return (
    <div>
      <PageHead
        title="Comptes"
        subtitle="Connexion aux comptes Claude et Codex utilisés par les agents."
      />
      <div className={s.cards}>
        <ClaudeAccountGroup />
        {codexAvailable ? <CodexAccountGroup /> : <CodexUnavailableCard />}
      </div>
    </div>
  );
}

type CardState = "loading" | "connected" | "disconnected" | "error";

/** The presentational shell shared by both backends: brand-themed card with the mark
 *  tile, a live status chip, an identity/invite body, an actions row and free-form
 *  sub-content (login sub-rows, errors). All logic lives in the callers. */
function AccountCard({
  brand,
  mark,
  name,
  provider,
  state,
  email,
  pills,
  invite,
  actions,
  children,
}: {
  brand: "claude" | "codex";
  mark: ReactNode;
  name: string;
  provider: string;
  state: CardState;
  email?: string | null;
  pills?: { label: string; plan?: boolean }[];
  invite?: string;
  actions: ReactNode;
  children?: ReactNode;
}) {
  const chip =
    state === "connected"
      ? { tone: "ok", label: "Connecté" }
      : state === "loading"
        ? { tone: "idle", label: "Vérification…" }
        : state === "error"
          ? { tone: "off", label: "Indisponible" }
          : { tone: "off", label: "Non connecté" };
  return (
    <section className={s.card} data-state={state} style={{ ["--brand" as string]: BRAND[brand] }}>
      <div className={s.head}>
        <span className={s.tile}>{mark}</span>
        <div className={s.headText}>
          <span className={s.brandName}>{name}</span>
          <span className={s.provider}>{provider}</span>
        </div>
        <span className={s.chip} data-tone={chip.tone}>
          <span className={s.chipDot} />
          {chip.label}
        </span>
      </div>

      <div className={s.body}>
        {state === "loading" ? (
          <>
            <div className={s.skelLine} style={{ width: "45%" }} />
            <div className={s.skelLine} style={{ width: "28%", marginTop: 10, height: 10 }} />
          </>
        ) : state === "connected" ? (
          <>
            <div className={s.email}>{email ?? "Connecté"}</div>
            {pills && pills.length ? (
              <div className={s.pills}>
                {pills.map((p) => (
                  <span key={p.label} className={p.plan ? `${s.pill} ${s.pillPlan}` : s.pill}>
                    {p.label}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className={s.invite}>{invite}</p>
        )}
      </div>

      <div className={s.actions}>{actions}</div>
      {children}
    </section>
  );
}

/** Inline fallback when the browser open failed: the error plus the auth URL itself,
 *  clickable (retries the opener) and selectable (copy by hand). */
function OpenUrlFallback({ error, url, onRetry }: { error: string; url: string; onRetry: () => void }) {
  return (
    <div className={s.err}>
      {error}
      {" — ouvre ce lien à la main : "}
      <span
        role="link"
        tabIndex={0}
        className={s.errLink}
        title="Réessayer d'ouvrir dans le navigateur — le texte reste sélectionnable pour le copier"
        onClick={onRetry}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRetry();
        }}
      >
        {url}
      </span>
    </div>
  );
}

/** The browser-open step of a login flow. `openUrl`'s rejection is NEVER swallowed
 *  (zero-silent-error): it lands in `error`, and `url` keeps the auth link around so
 *  the UI can offer the manual fallback (clickable retry + copiable text) — the flow
 *  must stay completable even when the opener is broken (no default browser…). */
function useAuthUrlOpener() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (u: string) => {
    setUrl(u);
    setError(null);
    openUrl(u).catch((e: unknown) => {
      setError(`Impossible d'ouvrir le navigateur : ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  return { url, error, open };
}

/** Logout button with an inline two-step confirmation (shared by both backends). */
function LogoutControl({ pending, onConfirm }: { pending: boolean; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <>
        <span className={s.spacer} />
        <button className={`${s.btn} ${s.ghost}`} onClick={() => setConfirming(true)}>
          Se déconnecter…
        </button>
      </>
    );
  }
  return (
    <>
      <span className={s.spacer} />
      <button
        className={`${s.btn} ${s.danger}`}
        disabled={pending}
        onClick={() => onConfirm()}
      >
        {pending ? "Déconnexion…" : "Confirmer la déconnexion"}
      </button>
      <button
        className={`${s.btn} ${s.ghost}`}
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Annuler
      </button>
    </>
  );
}

function ClaudeAccountGroup() {
  const status = useClaudeAccount(true);
  const { loginStart, loginCode, loginCancel, logout } = useClaudeAccountActions();
  // The two-step login: null = idle; "code" = URL opened, waiting for the pasted code.
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const opener = useAuthUrlOpener();
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
        opener.open(url);
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
  const cancelLogin = () => loginCancel.mutate(undefined, { onSettled: () => setStep("idle") });

  const logged = status.data?.loggedIn === true;
  const state: CardState = status.isLoading
    ? "loading"
    : status.isError
      ? "error"
      : logged
        ? "connected"
        : "disconnected";

  const actions = logged ? (
    <LogoutControl
      pending={logout.isPending}
      onConfirm={() => logout.mutate()}
    />
  ) : step === "idle" ? (
    <>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.connect}`} disabled={loginStart.isPending} onClick={startLogin}>
        <ClaudeMark /> {loginStart.isPending ? "Ouverture…" : "Se connecter"}
      </button>
    </>
  ) : (
    <span className={s.provider}>Connexion en cours…</span>
  );

  return (
    <AccountCard
      brand="claude"
      mark={<ClaudeMark />}
      name="Claude"
      provider="Anthropic · claude.ai"
      state={state}
      email={status.data?.email}
      pills={[
        status.data?.subscriptionType
          ? { label: `Forfait ${status.data.subscriptionType}`, plan: true }
          : null,
        status.data?.orgName ? { label: status.data.orgName } : null,
      ].filter(Boolean) as { label: string; plan?: boolean }[]}
      invite={
        status.isError
          ? `Statut indisponible : ${(status.error as Error).message}`
          : "Connecte le compte Anthropic que le CLI claude utilisera pour tes conversations."
      }
      actions={actions}
    >
      {step === "code" ? (
        <div className={s.subRow}>
          <span className={s.subLabel}>
            Autorise dans le navigateur, copie le code affiché, puis colle-le ici.
          </span>
          <input
            className={s.codeInput}
            value={code}
            autoFocus
            placeholder="Code d'autorisation…"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCode();
            }}
          />
          <button
            className={`${s.btn} ${s.connect}`}
            disabled={!code.trim() || loginCode.isPending}
            onClick={submitCode}
          >
            {loginCode.isPending ? "Validation…" : "Valider"}
          </button>
          <button className={`${s.btn} ${s.ghost}`} disabled={loginCode.isPending} onClick={cancelLogin}>
            Annuler
          </button>
        </div>
      ) : null}
      {step === "code" && opener.error && opener.url ? (
        <OpenUrlFallback error={opener.error} url={opener.url} onRetry={() => opener.open(opener.url!)} />
      ) : null}
      {err ? <div className={s.err}>{err}</div> : null}
    </AccountCard>
  );
}

function CodexAccountGroup() {
  const status = useCodexAccount(true);
  const { loginStart, loginCancel, logout } = useCodexAccountActions();
  // "waiting" = URL opened, the dedicated app-server is holding the OAuth callback;
  // the outcome arrives as the app-global `account_login` event.
  const [waiting, setWaiting] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const opener = useAuthUrlOpener();

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

  // Surface a failure that landed while this panel was CLOSED: the async Codex login can
  // complete minutes after the user navigated away, so the in-panel listener above misses
  // it. The always-mounted global handler stashed the reason — read it on mount and consume
  // it, so the reopened panel explains the failure instead of a bare "Non connecté".
  useEffect(() => {
    const stashed = useAccountLoginStore.getState().failures.codex;
    if (stashed) {
      setLoginErr(stashed.error ?? "la connexion a échoué");
      useAccountLoginStore.getState().clear("codex");
    }
  }, []);

  const err =
    loginErr ??
    (loginStart.error as Error | null)?.message ??
    (logout.error as Error | null)?.message ??
    null;
  const startLogin = () => {
    setLoginErr(null);
    useAccountLoginStore.getState().clear("codex"); // a new attempt supersedes any stashed failure
    loginStart.mutate(undefined, {
      onSuccess: (res) => {
        setWaiting(true);
        opener.open(res.authUrl);
      },
    });
  };
  const cancelLogin = () => loginCancel.mutate(undefined, { onSettled: () => setWaiting(false) });

  const logged = status.data?.loggedIn === true;
  const state: CardState = status.isLoading
    ? "loading"
    : status.isError
      ? "error"
      : logged
        ? "connected"
        : "disconnected";

  const actions = logged ? (
    <LogoutControl pending={logout.isPending} onConfirm={() => logout.mutate()} />
  ) : waiting ? (
    <>
      <span className={s.waiting}>
        <span className={s.waitingDot} />
        Autorise dans le navigateur…
      </span>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.ghost}`} onClick={cancelLogin}>
        Annuler
      </button>
    </>
  ) : (
    <>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.connect}`} disabled={loginStart.isPending} onClick={startLogin}>
        <CodexMark /> {loginStart.isPending ? "Ouverture…" : "Se connecter"}
      </button>
    </>
  );

  return (
    <AccountCard
      brand="codex"
      mark={<CodexMark />}
      name="Codex"
      provider="OpenAI · ChatGPT"
      state={state}
      email={status.data?.email}
      pills={[
        status.data?.planType ? { label: `Forfait ${status.data.planType}`, plan: true } : null,
        status.data?.authMethod === "chatgpt" ? { label: "Compte ChatGPT" } : null,
      ].filter(Boolean) as { label: string; plan?: boolean }[]}
      invite={
        status.isError
          ? `Statut indisponible : ${(status.error as Error).message}`
          : "Connecte le compte ChatGPT que le CLI codex utilisera pour tes conversations."
      }
      actions={actions}
    >
      {waiting && opener.error && opener.url ? (
        <OpenUrlFallback error={opener.error} url={opener.url} onRetry={() => opener.open(opener.url!)} />
      ) : null}
      {err ? <div className={s.err}>{err}</div> : null}
    </AccountCard>
  );
}

/** Codex binary absent: a muted card that points at the install command instead of a
 *  dead "Se connecter" (login is impossible without the CLI). */
function CodexUnavailableCard() {
  return (
    <AccountCard
      brand="codex"
      mark={<CodexMark />}
      name="Codex"
      provider="OpenAI · ChatGPT"
      state="disconnected"
      invite="CLI Codex introuvable. Installe le binaire (npm i -g @openai/codex) pour connecter un compte."
      actions={<span className={s.spacer} />}
    />
  );
}
