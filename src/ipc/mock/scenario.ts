// Scripted fixture timeline for the browser mock (dev / Playwright).
//
// It replays a realistic Claude Code turn over the same event shapes the Rust core
// emits, so the conversation UI can be developed and screenshotted with zero backend:
//   send → busy → stream text → tool_use(Read) → tool_result → stream text + code
//        → tool_use(Edit) → PERMISSION (pause) → [answer] → tool_result → final → turn_result → idle
//
// Token-by-token deltas with small delays so Playwright can capture mid-stream.

import type {
  ConversationItem,
  PermissionDecision,
  PermissionRequestPayload,
  SessionStatePayload,
} from "../client";

export interface ScenarioEmit {
  state: (s: SessionStatePayload) => void;
  item: (i: ConversationItem) => void;
  permission: (p: PermissionRequestPayload) => void;
}

const MODEL = "claude-opus-4-8[1m]";
export const MOCK_SESSION_ID = "01HVMOCK-S3SSION-ID";

const baseState: SessionStatePayload = {
  busy: false,
  session_id: MOCK_SESSION_ID,
  cwd: null,
  model: MODEL,
  permission_mode: "auto",
  activity: null,
  awaiting_permission: false,
  ended: false,
};

export const idleState = (): SessionStatePayload => ({ ...baseState });

// ---- Fixture content -------------------------------------------------------

const M1_TEXT =
  "Je vais inspecter `src/App.tsx` pour comprendre le bug de streaming, puis proposer un correctif.\n\n";

const READ_RESULT = `  9  useEffect(() => {
 10    // s'abonne mais ne nettoie jamais -> fuite de listeners
 11    events.sessionMessageEvent.listen((e) => apply(e.payload));
 12  }, []);`;

const M2_TEXT = `Le problème : le \`useEffect\` s'abonne à l'événement mais ne **désabonne** jamais au démontage, ce qui fuite un listener à chaque montage. Voici le correctif :

\`\`\`tsx
useEffect(() => {
  const un = events.sessionMessageEvent.listen((e) => apply(e.payload));
  return () => { un.then((f) => f()); };
}, [session]);
\`\`\`

J'applique le changement.`;

const EDIT_OLD = `  useEffect(() => {
    events.sessionMessageEvent.listen((e) => apply(e.payload));
  }, []);`;

const EDIT_NEW = `  useEffect(() => {
    const un = events.sessionMessageEvent.listen((e) => apply(e.payload));
    return () => { un.then((f) => f()); };
  }, [session]);`;

const EDIT_INPUT = {
  file_path: "src/App.tsx",
  old_string: EDIT_OLD,
  new_string: EDIT_NEW,
};

const M3_ALLOW =
  "C'est corrigé ✓ L'abonnement est désormais nettoyé au démontage — plus de fuite de listeners. Veux-tu que je lance les tests ?";

const M3_DENY =
  "Compris, je n'applique pas le changement. Dis-moi si tu préfères une autre approche.";

const PERMISSION: PermissionRequestPayload = {
  request_id: "perm_edit_1",
  tool_name: "Edit",
  tool_use_id: "toolu_edit",
  input: EDIT_INPUT,
  title: "Edit src/App.tsx",
  description: "Appliquer le correctif de nettoyage de l'abonnement",
  suggestions: [],
};

const Q_INTRO =
  "Avant de coder l'authentification, j'ai besoin de ton avis sur deux points :\n\n";

const QUESTION: PermissionRequestPayload = {
  request_id: "ask_q_1",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_ask",
  input: {
    questions: [
      {
        header: "Approche",
        question: "Quelle approche d'authentification préfères-tu ?",
        multiSelect: false,
        options: [
          { label: "JWT (stateless)", description: "Jetons signés, pas d'état serveur, simple à scaler." },
          { label: "Sessions serveur", description: "Cookie + store côté serveur, révocation facile." },
          { label: "OAuth délégué", description: "Google / GitHub, aucun mot de passe à gérer." },
        ],
      },
      {
        header: "Stockage",
        question: "Où stocker le token côté client ?",
        multiSelect: false,
        options: [
          { label: "Cookie httpOnly", description: "Inaccessible au JS, recommandé." },
          { label: "localStorage", description: "Simple, mais exposé au XSS." },
        ],
      },
      {
        header: "Extras",
        question: "Quelles protections veux-tu activer ? (plusieurs choix possibles)",
        multiSelect: true,
        options: [
          { label: "Rate limiting", description: "Limiter les tentatives de connexion." },
          { label: "2FA", description: "Double authentification (TOTP)." },
          { label: "Refresh tokens", description: "Renouvellement silencieux des sessions." },
        ],
      },
    ],
  },
  title: "Claude te pose une question",
  description: "Ton choix oriente la suite de l'implémentation.",
  suggestions: [],
};

// ---- Driver ----------------------------------------------------------------

/**
 * Drives one scripted turn. `start()` runs up to the permission prompt and pauses;
 * `resolvePermission()` resumes with the continuation matching the decision.
 */
export class ScenarioDriver {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private clock = 0;
  private awaiting = false;
  private mode: "edit" | "question" = "edit";
  private pendingId: string | null = null;

  constructor(
    private emit: ScenarioEmit,
    private busyState: SessionStatePayload = { ...baseState, busy: true, activity: "thinking" },
  ) {}

  /** Schedule `fn` `deltaMs` after the previous scheduled step. */
  private step(deltaMs: number, fn: () => void) {
    this.clock += deltaMs;
    this.timers.push(setTimeout(fn, this.clock));
  }

  private streamText(messageId: string, text: string, chunk = 3, perChunkMs = 26) {
    for (let i = 0; i < text.length; i += chunk) {
      const piece = text.slice(i, i + chunk);
      this.step(perChunkMs, () =>
        this.emit.item({ kind: "text_delta", message_id: messageId, text: piece }),
      );
    }
  }

  start() {
    this.reset();
    this.mode = "edit";
    this.pendingId = PERMISSION.request_id;
    this.emit.state({ ...this.busyState });

    // --- m1: intro + Read tool ---
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m1", M1_TEXT);
    this.step(180, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: M1_TEXT },
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "src/App.tsx" } },
        ],
      }),
    );
    this.step(520, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_read",
        content: READ_RESULT,
        is_error: false,
        parent_tool_use_id: null,
      }),
    );

    // --- m2: diagnosis + code + Edit tool ---
    this.step(300, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m2", M2_TEXT, 3, 20);
    this.step(180, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: M2_TEXT },
          { type: "tool_use", id: "toolu_edit", name: "Edit", input: EDIT_INPUT },
        ],
      }),
    );

    // --- permission prompt, then PAUSE ---
    this.step(360, () => {
      this.awaiting = true;
      this.emit.permission(PERMISSION);
      this.emit.state({ ...baseState, busy: true, activity: null, awaiting_permission: true });
    });
  }

  /** Scripted AskUserQuestion flow: short intro, then a questionnaire prompt. */
  startQuestion() {
    this.reset();
    this.mode = "question";
    this.pendingId = QUESTION.request_id;
    this.emit.state({ ...this.busyState });

    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m1", Q_INTRO);
    this.step(180, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [{ type: "text", text: Q_INTRO }],
      }),
    );
    this.step(320, () => {
      this.awaiting = true;
      this.emit.permission(QUESTION);
      this.emit.state({ ...baseState, busy: true, activity: null, awaiting_permission: true });
    });
  }

  /** Resume the turn after the user answers the pending prompt. */
  resolvePermission(requestId: string, decision: PermissionDecision) {
    if (!this.awaiting || requestId !== this.pendingId) return;
    this.awaiting = false;
    this.reset();
    const allowed = decision.behavior === "allow";

    if (this.mode === "question") {
      this.emit.state({ ...baseState, busy: true, activity: null });

      // Realistic AskUserQuestion tool card, mirroring the CLI: the recorded
      // tool_use carries ONLY the questions (no answers), and the answers come
      // back in the tool_result string — exercising the parser end-to-end.
      if (decision.behavior === "allow" && decision.updated_input) {
        const upd = decision.updated_input;
        const answers =
          upd && typeof upd === "object" && !Array.isArray(upd)
            ? ((upd as Record<string, unknown>).answers as Record<string, string> | undefined)
            : undefined;
        const pairs = Object.entries(answers ?? {})
          .map(([q, a]) => `"${q}"="${a}"`)
          .join(", ");
        const resultText = pairs
          ? `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`
          : "L'utilisateur a ignoré le questionnaire sans répondre.";
        this.step(120, () =>
          this.emit.item({
            kind: "assistant_message",
            id: "mq0",
            parent_tool_use_id: null,
            blocks: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: QUESTION.input }],
          }),
        );
        this.step(180, () =>
          this.emit.item({
            kind: "tool_result",
            tool_use_id: "toolu_ask",
            content: resultText,
            is_error: false,
            parent_tool_use_id: null,
          }),
        );
      }

      const txt = allowed
        ? "Parfait, c'est noté — je pars sur cette approche et je commence l'implémentation."
        : "Ok, je n'avance pas pour l'instant. Dis-moi quand tu veux qu'on en reparle.";
      this.step(260, () =>
        this.emit.item({ kind: "message_started", id: "mq", role: "assistant", parent_tool_use_id: null }),
      );
      this.streamText("mq", txt, 3, 22);
      this.step(160, () =>
        this.emit.item({
          kind: "assistant_message",
          id: "mq",
          parent_tool_use_id: null,
          blocks: [{ type: "text", text: txt }],
        }),
      );
      this.step(220, () =>
        this.emit.item({
          kind: "turn_result",
          subtype: "success",
          is_error: false,
          result: null,
          total_cost_usd: 0.0061,
          num_turns: 1,
          duration_ms: 4200,
        }),
      );
      this.step(40, () => this.emit.state(idleState()));
      return;
    }

    this.emit.state({ ...baseState, busy: true, activity: allowed ? "editing" : null });
    this.step(220, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_edit",
        content: allowed
          ? "The file src/App.tsx has been updated successfully."
          : "Permission denied by user.",
        is_error: !allowed,
        parent_tool_use_id: null,
      }),
    );

    const finalText = allowed ? M3_ALLOW : M3_DENY;
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m3", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m3", finalText, 3, 22);
    this.step(160, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m3",
        parent_tool_use_id: null,
        blocks: [{ type: "text", text: finalText }],
      }),
    );
    this.step(220, () =>
      this.emit.item({
        kind: "turn_result",
        subtype: allowed ? "success" : "success",
        is_error: false,
        result: null,
        total_cost_usd: 0.0142,
        num_turns: 3,
        duration_ms: 9300,
      }),
    );
    this.step(40, () => this.emit.state(idleState()));
  }

  /** Interrupt the current turn: stop streaming, finalize, go idle. */
  interrupt() {
    this.reset();
    this.awaiting = false;
    this.emit.item({
      kind: "turn_result",
      subtype: "interrupted",
      is_error: false,
      result: null,
      total_cost_usd: null,
      num_turns: null,
      duration_ms: null,
    });
    this.emit.state(idleState());
  }

  /** Clear all pending timers (used on pause, resume, interrupt, teardown). */
  reset() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.clock = 0;
  }
}
