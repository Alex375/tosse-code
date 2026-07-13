// Settings → Accounts: the in-app login/logout/status for BOTH backends, as graphical
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
import { useBackendAvailabilityState } from "../../store/binaryAvailable";
import { useAccountLoginStore } from "../../store/accountLogin";
import { ClaudeMark, CodexMark } from "../../ui/kit";
import { PageHead } from "./SettingsKit";
import s from "./AccountsSection.module.css";

// The brand accent each card is themed with (drives the glow, tile, plan pill, CTA).
// Shared design tokens (conductor-wirekit.css), never raw hex — so a brand tweak is
// one edit and the Accounts card / Extensions tab / Plan pill never diverge.
const BRAND: Record<"claude" | "codex", string> = {
  claude: "var(--wf-accent)", // coral
  codex: "var(--wf-codex-accent)", // OpenAI green
};

export function AccountsSection() {
  // Tri-state (null while the one-shot probe is in flight): show the alarming
  // "CLI not found" card ONLY on a DEFINITIVE `false`. While still checking (null), render
  // the normal account group — it has its own "Checking…" skeleton — so a user who has
  // the CLI installed never sees a scary "not found" flash before the check resolves.
  const claude = useBackendAvailabilityState("claude");
  const codex = useBackendAvailabilityState("codex");
  return (
    <div>
      <PageHead
        title="Accounts"
        subtitle="Sign in to the Claude and Codex accounts used by the agents."
      />
      <div className={s.cards}>
        {claude === false ? <ClaudeUnavailableCard /> : <ClaudeAccountGroup />}
        {codex === false ? <CodexUnavailableCard /> : <CodexAccountGroup />}
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
      ? { tone: "ok", label: "Connected" }
      : state === "loading"
        ? { tone: "idle", label: "Checking…" }
        : state === "error"
          ? { tone: "off", label: "Unavailable" }
          : { tone: "off", label: "Not connected" };
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
            <div className={s.email}>{email ?? "Connected"}</div>
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
      {" — open this link manually: "}
      <span
        role="link"
        tabIndex={0}
        className={s.errLink}
        title="Retry opening in the browser — the text stays selectable so you can copy it"
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
 *  the UI can offer the manual fallback (clickable retry + copyable text) — the flow
 *  must stay completable even when the opener is broken (no default browser…). */
function useAuthUrlOpener() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (u: string) => {
    setUrl(u);
    setError(null);
    openUrl(u).catch((e: unknown) => {
      setError(`Unable to open the browser: ${e instanceof Error ? e.message : String(e)}`);
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
          Sign out…
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
        {pending ? "Signing out…" : "Confirm sign-out"}
      </button>
      <button
        className={`${s.btn} ${s.ghost}`}
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Cancel
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
      // On failure the CLI child has exited: back to idle so "Sign in" restarts
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
        <ClaudeMark /> {loginStart.isPending ? "Opening…" : "Sign in"}
      </button>
    </>
  ) : (
    <span className={s.provider}>Signing in…</span>
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
          ? { label: `Plan ${status.data.subscriptionType}`, plan: true }
          : null,
        status.data?.orgName ? { label: status.data.orgName } : null,
      ].filter(Boolean) as { label: string; plan?: boolean }[]}
      invite={
        status.isError
          ? `Status unavailable: ${(status.error as Error).message}`
          : "Sign in to the Anthropic account the claude CLI will use for your conversations."
      }
      actions={actions}
    >
      {step === "code" ? (
        <div className={s.subRow}>
          <span className={s.subLabel}>
            Authorize in the browser, copy the code shown, then paste it here.
          </span>
          <input
            className={s.codeInput}
            value={code}
            autoFocus
            placeholder="Authorization code…"
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
            {loginCode.isPending ? "Validating…" : "Submit"}
          </button>
          <button className={`${s.btn} ${s.ghost}`} disabled={loginCode.isPending} onClick={cancelLogin}>
            Cancel
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
      setLoginErr(e.payload.success ? null : (e.payload.error ?? "sign-in failed"));
    });
    return () => {
      disposed = true;
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  // Surface a failure that landed while this panel was CLOSED: the async Codex login can
  // complete minutes after the user navigated away, so the in-panel listener above misses
  // it. The always-mounted global handler stashed the reason — read it on mount and consume
  // it, so the reopened panel explains the failure instead of a bare "Not connected".
  useEffect(() => {
    const stashed = useAccountLoginStore.getState().failures.codex;
    if (stashed) {
      setLoginErr(stashed.error ?? "sign-in failed");
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
        Authorize in the browser…
      </span>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.ghost}`} onClick={cancelLogin}>
        Cancel
      </button>
    </>
  ) : (
    <>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.connect}`} disabled={loginStart.isPending} onClick={startLogin}>
        <CodexMark /> {loginStart.isPending ? "Opening…" : "Sign in"}
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
        status.data?.planType ? { label: `Plan ${status.data.planType}`, plan: true } : null,
        status.data?.authMethod === "chatgpt" ? { label: "ChatGPT account" } : null,
      ].filter(Boolean) as { label: string; plan?: boolean }[]}
      invite={
        status.isError
          ? `Status unavailable: ${(status.error as Error).message}`
          : "Sign in to the ChatGPT account the codex CLI will use for your conversations."
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

/** Claude binary absent: a muted card that points at the install command instead of a
 *  dead "Sign in" (login — `claude auth login` — is impossible without the CLI).
 *  Replaces the confusing "Status unavailable: <error>" the live card would otherwise
 *  show when the `claude auth status` probe fails for want of the binary. */
function ClaudeUnavailableCard() {
  return (
    <AccountCard
      brand="claude"
      mark={<ClaudeMark />}
      name="Claude"
      provider="Anthropic · claude.ai"
      state="disconnected"
      invite="Claude CLI not found. Install Claude Code (npm i -g @anthropic-ai/claude-code) to connect an account."
      actions={<span className={s.spacer} />}
    />
  );
}

/** Codex binary absent: a muted card that points at the install command instead of a
 *  dead "Sign in" (login is impossible without the CLI). */
function CodexUnavailableCard() {
  return (
    <AccountCard
      brand="codex"
      mark={<CodexMark />}
      name="Codex"
      provider="OpenAI · ChatGPT"
      state="disconnected"
      invite="Codex CLI not found. Install the binary (npm i -g @openai/codex) to connect an account."
      actions={<span className={s.spacer} />}
    />
  );
}
