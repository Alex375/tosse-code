// Scripted fixture timeline for the browser mock (dev / Playwright).
//
// It replays a realistic Claude Code turn over the same event shapes the Rust core
// emits, so the conversation UI can be developed and screenshotted with zero backend:
//   send → busy → stream text → tool_use(Read, Grep, Glob) → tool_results → stream
//        text + code → tool_use(Edit) → PERMISSION (pause) → [answer] → tool_result
//        → final → turn_result → idle
// The first message runs three consecutive tools so the grouped "Exécuté N étapes"
// section (ToolSection) is exercised by the mock, not just a single-step run.
//
// Token-by-token deltas with small delays so Playwright can capture mid-stream.

import type {
  BackgroundTask,
  ConversationItem,
  PermissionDecision,
  PermissionRequestPayload,
  SessionStatePayload,
  WorkflowRun,
} from "../client";

export interface ScenarioEmit {
  state: (s: SessionStatePayload) => void;
  item: (i: ConversationItem) => void;
  permission: (p: PermissionRequestPayload) => void;
  /** Background-task lifecycle snapshot (optional — only the bg demo emits these). */
  task?: (t: BackgroundTask) => void;
}

/** Build a full BackgroundTask from a partial (mock convenience). */
function taskOf(p: Partial<BackgroundTask> & { task_id: string }): BackgroundTask {
  return {
    kind: "agent",
    tool_use_id: null,
    label: null,
    command: null,
    subagent_type: null,
    model: null,
    agent_id: null,
    status: "running",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: null,
    ...p,
  };
}

/** A finished sub-agent transcript — what `load_subagent_transcript` returns. Used by
 *  the browser mock so the transcript popover renders real-shaped content in dev. */
export const DEMO_SUBAGENT_TRANSCRIPT: ConversationItem[] = [
  {
    kind: "user_message",
    id: "su1",
    parent_tool_use_id: null,
    text: "Explore the supervisor module and map its structure: the protocol types, the assembler, and how background tasks flow through it. Return a concise structured map.",
    replay: false,
  },
  {
    kind: "assistant_message",
    id: "sa1",
    parent_tool_use_id: null,
    blocks: [
      { type: "thinking", text: "Let me list the supervisor directory first, then read the key files to map the data flow." },
      { type: "text", text: "Je commence par lister le module `supervisor/`, puis je lis les fichiers clés." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -1 src-tauri/src/supervisor", description: "list module" } },
    ],
  },
  {
    kind: "tool_result",
    tool_use_id: "t1",
    is_error: false,
    parent_tool_use_id: null,
    content: "assembler.rs\ncontrol.rs\nhistory.rs\nmodel.rs\nprotocol.rs\nsession.rs\nsubagents.rs\ntransport.rs",
  },
  {
    kind: "assistant_message",
    id: "sa2",
    parent_tool_use_id: null,
    blocks: [
      {
        type: "text",
        text: "Voici la carte du module :\n\n- **protocol.rs** — types serde du fil stream-json\n- **assembler.rs** — normalisation + registre des tâches de fond\n- **session.rs** — acteur tokio par session\n- **subagents.rs** — lecteurs disque (transcript sous-agent, manifeste workflow)\n\nFlux des tâches de fond : `task_started → task_progress → task_updated → task_notification`, chaque event ré-émis comme un `BackgroundTask` complet.",
      },
    ],
  },
];

/** A canned workflow-run manifest — what `load_workflow_run` returns — so the
 *  <WorkflowDetail> 3-panel view (phases → agents → transcript) renders real-shaped content
 *  in dev. Mirrors the on-disk `workflows/wf_<id>.json` shape (camelCase, raw
 *  workflowProgress entries). Two phases: Research (one agent done, one running) and Verify
 *  (one queued). */
export const DEMO_WORKFLOW_RUN: WorkflowRun = {
  runId: "wf_demo123",
  taskId: "tk_wf",
  // The mock returns this only once the run is DONE (the manifest is end-only), so completed.
  status: "completed",
  workflowName: "review-changes",
  defaultModel: "claude-opus-4-8",
  durationMs: 18420,
  agentCount: 3,
  totalTokens: 64210,
  totalToolCalls: 27,
  summary: null,
  phases: [
    { title: "Research", detail: "explore the diff across dimensions" },
    { title: "Verify", detail: "adversarially confirm each finding" },
  ],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Research" },
    {
      type: "workflow_agent",
      index: 1,
      label: "r-correctness",
      phaseTitle: "Research",
      phaseIndex: 1,
      agentId: "demoagent_fg",
      agentType: "general-purpose",
      model: "claude-opus-4-8",
      state: "done",
      tokens: 31840,
      toolCalls: 14,
      durationMs: 9120,
      promptPreview:
        "Review the changed files for correctness bugs: off-by-one, null handling, race conditions. Return structured findings.",
      resultPreview:
        "2 findings: (1) unguarded array access in parseWorkflow when workflowProgress is null; (2) poll interval not cleared on unmount.",
    },
    {
      type: "workflow_agent",
      index: 2,
      label: "r-perf",
      phaseTitle: "Research",
      phaseIndex: 1,
      agentId: "demoagent_bg",
      agentType: "general-purpose",
      model: "claude-opus-4-8",
      state: "running",
      tokens: 12480,
      toolCalls: 6,
      promptPreview: "Review the changed files for performance regressions and needless re-renders.",
      lastToolName: "Grep",
    },
    { type: "workflow_phase", index: 2, title: "Verify" },
    {
      type: "workflow_agent",
      index: 3,
      label: "v-correctness",
      phaseTitle: "Verify",
      phaseIndex: 2,
      agentId: "demoagent_v",
      agentType: "general-purpose",
      model: "claude-haiku-4-5",
      state: "queued",
      promptPreview: "Adversarially verify each correctness finding — try to refute it.",
    },
  ],
  result: null,
};

// Demo-only flag: the dynamic workflow's manifest exists ONLY once the run is done (mirrors
// reality — the CLI writes it at the end). While false, the mock's `load_workflow_run` returns
// null so the modal shows its LIVE overview; once true it returns the rich manifest. Flipped
// by the workflow demo's completion step.
let demoWorkflowDone = false;
export function isDemoWorkflowDone(): boolean {
  return demoWorkflowDone;
}

/** Canned output for the background-shell demo, returned by the mock's
 *  `read_task_output` so the <BashOutputPopover> renders real-shaped logs in dev. */
const BASH_OUTPUTS: Record<string, string> = {
  tk_dev:
    "VITE v5.4.2  ready in 412 ms\n\n  ➜  Local:   http://localhost:1420/\n  ➜  Network: use --host to expose\n  ➜  press h + enter to show help\n\n[12:04:18] hmr update /src/App.tsx\n[12:04:31] hmr update /src/ui/conductor-conversation.css\n",
  tk_build:
    "vite v5.4.2 building for production...\n✓ 1240 modules transformed.\ndist/index.html                   0.46 kB │ gzip:  0.30 kB\ndist/assets/index-a1b2c3.css     38.91 kB │ gzip:  7.12 kB\ndist/assets/index-d4e5f6.js     284.10 kB │ gzip: 92.34 kB\n✓ built in 9.40s\n",
};

/** Canned event stream for the Monitor demo, returned by the mock's `read_task_output`
 *  so the <MonitorBar>'s <TaskOutputPopover> tails real-shaped events in dev. One line
 *  per event — the append-only shape the `Monitor` tool writes to `tasks/<id>.output`. */
const MONITOR_OUTPUTS: Record<string, string> = {
  tk_mon:
    "[12:04:18] GET /api/health 200 4ms\n[12:04:19] GET /api/tasks 200 22ms\n[12:04:21] POST /api/login 401 8ms\n[12:04:23] GET /api/tasks 200 19ms\n[12:04:26] WARN slow query (842ms) tasks.list\n[12:04:28] GET /api/health 200 3ms\n",
  tk_mon2:
    "▶ build started\n✓ typecheck passed\n✓ 1240 modules transformed\n✓ built in 9.40s\n■ stream ended\n",
};

/** The mock side of `read_task_output` — canned logs keyed by the demo task ids
 *  (background shell commands AND Monitor watches share the on-disk output sink). */
export function mockTaskOutput(taskId: string): string | null {
  return BASH_OUTPUTS[taskId] ?? MONITOR_OUTPUTS[taskId] ?? null;
}

const MODEL = "claude-opus-4-8[1m]";
export const MOCK_SESSION_ID = "01HVMOCK-S3SSION-ID";

const baseState: SessionStatePayload = {
  busy: false,
  session_id: MOCK_SESSION_ID,
  cwd: null,
  model: MODEL,
  permission_mode: "auto",
  effort: "xhigh",
  ultracode: false,
  activity: null,
  awaiting_permission: false,
  ended: false,
  context_tokens: 29756,
  context_window: 1000000,
  rate_limit: {
    status: "allowed",
    resets_at: Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60,
    limit_type: "five_hour",
    using_overage: false,
  },
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
  /** Background tasks emitted by the shell / monitor demos, so `stopTask` can re-emit a
   *  known one as stopped (mirroring the core's `stop_task` → `task_*` flow). */
  private bgTasks = new Map<string, BackgroundTask>();

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
          { type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "useState", path: "src" } },
          { type: "tool_use", id: "toolu_glob", name: "Glob", input: { pattern: "**/*.tsx" } },
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
    this.step(140, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_grep",
        content: "src/App.tsx:12: const [count, setCount] = useState(0)\nsrc/Counter.tsx:4: const [n] = useState(0)",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(140, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_glob",
        content: "src/App.tsx\nsrc/Counter.tsx\nsrc/main.tsx",
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

  /**
   * Background-tools demo (`?demo=background`): one FOREGROUND sub-agent (streams
   * inline, finishes) then one BACKGROUND sub-agent that keeps running after the turn
   * ends — so the inline card, the pinned AgentBar, the "backgrounding" status colour
   * and (via load_subagent_transcript) the transcript popover all render in dev.
   */
  startBackground() {
    this.reset();
    this.emit.state({ ...this.busyState });

    // --- foreground sub-agent: streams inline, then completes ---
    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "Je lance un audit de sécurité via un sous-agent.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          {
            type: "tool_use",
            id: "toolu_fg",
            name: "Agent",
            input: {
              description: "Audit sécurité",
              subagent_type: "security",
              prompt:
                "Audite la sécurité du module auth et liste les findings, classés par sévérité (haute / moyenne / basse), avec un correctif proposé pour chacun.",
            },
          },
        ],
      }),
    );
    this.step(60, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_fg", tool_use_id: "toolu_fg", label: "Audit sécurité", subagent_type: "security", model: "claude-haiku-4-5", status: "running" }),
      ),
    );
    // live sub-thread content (scoped under toolu_fg)
    this.step(240, () =>
      this.emit.item({ kind: "message_started", id: "sa_fg", role: "assistant", parent_tool_use_id: "toolu_fg" }),
    );
    this.step(160, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "sa_fg",
        parent_tool_use_id: "toolu_fg",
        blocks: [
          {
            type: "text",
            text: "3 findings : (1) pas de rate-limit sur `/login` [haute], (2) tokens en localStorage [moyenne], (3) pas de rotation des refresh tokens [moyenne].",
          },
        ],
      }),
    );
    this.step(200, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_fg", tool_use_id: "toolu_fg", label: "Audit sécurité", subagent_type: "security", model: "claude-haiku-4-5", status: "completed", agent_id: "demoagent_fg", tokens: 18400, tool_uses: 7, duration_ms: 21000 }),
      ),
    );
    this.step(120, () =>
      this.emit.item({ kind: "tool_result", tool_use_id: "toolu_fg", content: "3 findings rapportés (1 haute, 2 moyennes).", is_error: false, parent_tool_use_id: null }),
    );

    // --- background sub-agent: launched detached, stays running past the turn ---
    this.step(280, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    const t2 = "Maintenant je lance un explorateur du code en arrière-plan. Je te préviens quand c'est fini — tu peux continuer à me parler entre-temps.";
    this.streamText("m2", t2, 3, 18);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t2 },
          {
            type: "tool_use",
            id: "toolu_bg",
            name: "Agent",
            input: {
              description: "Explorer le code",
              subagent_type: "Explore",
              run_in_background: true,
              prompt: "Explore the supervisor module and map its structure: protocol types, the assembler, and how background tasks flow.",
            },
          },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_bg",
        content:
          "Async agent launched successfully.\nagentId: demoagent_bg\noutput_file: /Users/dev/.claude/projects/x/subagents/agent-demoagent_bg.jsonl",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_bg", tool_use_id: "toolu_bg", label: "Explorer le code", subagent_type: "Explore", model: "claude-sonnet-4-6", status: "running" }),
      ),
    );
    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.021, num_turns: 2, duration_ms: 26000, duration_api_ms: 18600, ttft_ms: 900 }),
    );
    // Idle main loop, but tk_bg keeps running → conversation goes "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …then the background agent finishes a few seconds later: it drops out of the
    // AgentBar / FlightDeck badge, and the conversation falls back from "backgrounding"
    // to idle. (Exercises the disappear-on-complete behaviour in dev.)
    this.step(14000, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_bg", tool_use_id: "toolu_bg", label: "Explorer le code", subagent_type: "Explore", model: "claude-sonnet-4-6", status: "completed", agent_id: "demoagent_bg", tokens: 42000, tool_uses: 15, duration_ms: 38000 }),
      ),
    );
  }

  /** Record + emit a background task snapshot (so `stopTask` can find it later). */
  private emitTask(t: BackgroundTask) {
    this.bgTasks.set(t.task_id, t);
    this.emit.task?.(t);
  }

  /**
   * Background-shell demo (`?demo=shell`): a FOREGROUND command (in flight while busy →
   * the bottom "$ command…" indicator, registre 1), then TWO `run_in_background`
   * commands — a dev server that keeps running (Stop button + live output tail) and a
   * build that completes a few seconds later (finished row with duration + exit code).
   * Exercises the pinned <BashBar>, the <BashOutputPopover> and stop_task end to end.
   */
  startShell() {
    this.reset();
    this.bgTasks.clear();
    this.emit.state({ ...this.busyState });

    // --- foreground command: stays in flight a moment → "$ pnpm test…" at the bottom ---
    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "Je lance la suite de tests, puis quelques commandes en arrière-plan.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "pnpm test -- --run", description: "run the test suite" } },
        ],
      }),
    );
    // Held in flight (no result) so the working indicator shows the live command.
    this.step(2200, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_fg",
        content: "Test Files  12 passed (12)\nTests  148 passed (148)\nDuration  3.41s",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );

    // --- background #1: a dev server that KEEPS running (Stop button + live tail) ---
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    const t2 = "Je démarre le serveur de dev en arrière-plan — tu peux continuer à me parler pendant ce temps.";
    this.streamText("m2", t2, 3, 18);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t2 },
          { type: "tool_use", id: "toolu_dev", name: "Bash", input: { command: "pnpm dev", description: "start dev server", run_in_background: true } },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_dev",
        content:
          "Command running in background with ID: tk_dev. Output is being written to: /Users/dev/.claude/projects/x/tasks/tk_dev.output. You will be notified when it completes.",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_dev", kind: "bash", tool_use_id: "toolu_dev", label: "pnpm dev", command: "pnpm dev --host", status: "running", output_file: "tasks/tk_dev.output" })),
    );

    // --- background #2: a build that COMPLETES a few seconds later ---
    this.step(220, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2b",
        parent_tool_use_id: null,
        blocks: [
          { type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "pnpm build", description: "production build", run_in_background: true } },
        ],
      }),
    );
    this.step(60, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_build",
        content:
          "Command running in background with ID: tk_build. Output is being written to: /Users/dev/.claude/projects/x/tasks/tk_build.output.",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_build", kind: "bash", tool_use_id: "toolu_build", label: "production build", command: "pnpm build", status: "running", output_file: "tasks/tk_build.output" })),
    );

    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.014, num_turns: 2, duration_ms: 8200, duration_api_ms: 6100, ttft_ms: 700 }),
    );
    // Idle main loop, but the two bg commands keep running → conversation "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …the build finishes a few seconds later: its row flips to completed (duration + exit).
    this.step(6000, () =>
      this.emitTask(
        taskOf({
          task_id: "tk_build",
          kind: "bash",
          tool_use_id: "toolu_build",
          label: "production build",
          command: "pnpm build",
          status: "completed",
          duration_ms: 9400,
          summary: 'Background command "pnpm build" completed (exit code 0)',
          output_file: "tasks/tk_build.output",
        }),
      ),
    );
  }

  /**
   * Background-monitor demo (`?demo=monitor`): the agent launches the `Monitor` tool —
   * a live watch whose every stdout line is an event (read from disk, NOT the wire). One
   * watch KEEPS streaming (persistent → Stop button + live event tail) and a second one
   * ENDS a few seconds later ("stream ended"). Exercises the pinned <MonitorBar>, its
   * <TaskOutputPopover> event tail, and stop_task end to end.
   */
  startMonitor() {
    this.reset();
    this.bgTasks.clear();
    this.emit.state({ ...this.busyState });

    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "Je mets en place deux watches en arrière-plan — tu peux continuer à me parler pendant ce temps.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "toolu_mon", name: "Monitor", input: { command: "tail -F /var/log/app.log", description: "watch des logs applicatifs", persistent: true, timeout_ms: 0 } },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_mon",
        content:
          "Monitor started (task tk_mon, persistent). You will be notified on each event. Keep working…",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_mon", kind: "monitor", tool_use_id: "toolu_mon", label: "watch des logs applicatifs", status: "running", output_file: "tasks/tk_mon.output" })),
    );

    // --- second watch: a build monitor that ENDS a few seconds later (stream ended) ---
    this.step(240, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1b",
        parent_tool_use_id: null,
        blocks: [
          { type: "tool_use", id: "toolu_mon2", name: "Monitor", input: { command: "pnpm build --watch", description: "watch du build", persistent: false, timeout_ms: 8000 } },
        ],
      }),
    );
    this.step(60, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_mon2",
        content: "Monitor started (task tk_mon2, timeout 8000ms). You will be notified on each event. Keep working…",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_mon2", kind: "monitor", tool_use_id: "toolu_mon2", label: "watch du build", status: "running", output_file: "tasks/tk_mon2.output" })),
    );

    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.009, num_turns: 1, duration_ms: 5200, duration_api_ms: 3800, ttft_ms: 600 }),
    );
    // Idle main loop, but the watches keep running → conversation "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …the build watch ends a few seconds later: its row drops out of the bar.
    this.step(6000, () =>
      this.emitTask(
        taskOf({
          task_id: "tk_mon2",
          kind: "monitor",
          tool_use_id: "toolu_mon2",
          label: "watch du build",
          status: "completed",
          duration_ms: 6400,
          summary: 'Monitor "watch du build" stream ended',
          output_file: "tasks/tk_mon2.output",
        }),
      ),
    );
  }

  /**
   * Dynamic-workflow demo (`?demo=workflow`): the agent launches the `Workflow` tool — a
   * fleet of sub-agents orchestrated across phases. A Workflow is ALWAYS a background task
   * (it returns immediately with a run id), so it lives in the pinned <WorkflowBar>, NOT
   * inline in the thread. The run keeps going past the turn → its row stays in the bar with
   * live phase progress; clicking it opens the <WorkflowDetail> 3-panel view (its manifest
   * comes from the mocked `load_workflow_run`). Exercises the bar, the modal and stop_task.
   */
  startWorkflow() {
    this.reset();
    this.bgTasks.clear();
    demoWorkflowDone = false; // run starts → manifest absent → modal shows the LIVE overview
    this.emit.state({ ...this.busyState });

    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "Je lance une revue multi-agents du diff via un workflow — tu peux continuer à me parler pendant ce temps.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "toolu_wf", name: "Workflow", input: { description: "review-changes", script: "export const meta = { name: 'review-changes' }" } },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_wf",
        content:
          "Workflow launched in background. Task ID: tk_wf\nSummary: Review the changed files across dimensions, verify each finding\nTranscript dir: /Users/dev/.claude/projects/x/subagents/workflows/wf_demo123\nRun ID: wf_demo123",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_wf", kind: "workflow", tool_use_id: "toolu_wf", label: "review-changes", status: "running", progress: "Research: r-correctness" })),
    );
    // Live phase progress ticks (coarse "<phase>: <label>" from the wire).
    this.step(2600, () =>
      this.emitTask(taskOf({ task_id: "tk_wf", kind: "workflow", tool_use_id: "toolu_wf", label: "review-changes", status: "running", progress: "Research: r-perf" })),
    );

    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.052, num_turns: 1, duration_ms: 6200, duration_api_ms: 4500, ttft_ms: 650 }),
    );
    // Idle main loop, but the workflow keeps running → conversation "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …later the workflow FINISHES: the manifest "lands" (mock flag flips → the modal upgrades
    // its live overview to the rich report) and the row drops out of the bar. (A long window so
    // the live overview is easy to inspect in dev.)
    this.step(20000, () => {
      demoWorkflowDone = true;
      this.emitTask(
        taskOf({
          task_id: "tk_wf",
          kind: "workflow",
          tool_use_id: "toolu_wf",
          label: "review-changes",
          status: "completed",
          duration_ms: 18420,
          summary: 'Workflow "review-changes" completed',
        }),
      );
    });
  }

  /** Mock the `stop_task` command: re-emit a known background task as stopped, exactly
   *  as the core would after the CLI kills it (the bar reflects it). Kind-aware summary
   *  so a watch reads "Monitor … stopped" and a command "Background command … stopped". */
  stopTask(taskId: string) {
    const t = this.bgTasks.get(taskId);
    if (!t) return;
    const fallback =
      t.kind === "monitor"
        ? `Monitor "${t.label}" stopped`
        : `Background command "${t.label}" stopped`;
    const stopped: BackgroundTask = {
      ...t,
      status: "stopped",
      summary: t.summary ?? fallback,
      duration_ms: t.duration_ms ?? 4200,
    };
    this.emitTask(stopped);
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
          api_error_status: null,
          total_cost_usd: 0.0061,
          num_turns: 1,
          duration_ms: 4200,
          duration_api_ms: 3100,
          ttft_ms: 550,
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
        api_error_status: null,
        total_cost_usd: 0.0142,
        num_turns: 3,
        duration_ms: 9300,
        duration_api_ms: 6800,
        ttft_ms: 800,
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
      api_error_status: null,
      total_cost_usd: null,
      num_turns: null,
      duration_ms: null,
      duration_api_ms: null,
      ttft_ms: null,
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
