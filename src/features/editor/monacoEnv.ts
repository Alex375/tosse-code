// Shared Monaco setup: the web-worker environment and the `tosse-dark` theme.
// Both the file editor (MonacoView) and the Git diff editor (DiffViewer) need
// these, and either may mount first — so the setup lives here, idempotent, and
// each calls `setupMonaco()` before creating its editor. Without it, whichever
// editor opens first while the other never has would run Monaco with no worker
// env (it falls back to the main thread, freezing the UI on large files and
// canceling diff computation).
//
// Workers: Vite bundles each as its own lazily-fetched chunk, so wiring them
// costs nothing at startup (this module only loads with a lazy editor) and a
// worker is fetched only when a file of that language is opened.

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoSelf = typeof globalThis & { MonacoEnvironment?: monaco.Environment };
const globalSelf = globalThis as MonacoSelf;

let workersDone = false;
let themeDone = false;

function setupWorkers() {
  if (workersDone || globalSelf.MonacoEnvironment) {
    workersDone = true;
    return;
  }
  workersDone = true;
  globalSelf.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}

function setupTheme() {
  if (themeDone) return;
  themeDone = true;
  // The app's dark palette (--wf-* tokens) so the editor + diffs blend in. Diff
  // colors are included so the Git diff editor reads even when shown standalone.
  monaco.editor.defineTheme("tosse-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0c0c0f",
      "editor.foreground": "#e7e7ec",
      "editorLineNumber.foreground": "#4a4a55",
      "editorLineNumber.activeForeground": "#a6a6b0",
      "editor.selectionBackground": "#2a3350",
      "editor.lineHighlightBackground": "#15151b",
      "editorCursor.foreground": "#d97757",
      "editorIndentGuide.background1": "#20202a",
      "editorWidget.background": "#15151b",
      "editorWidget.border": "#26262f",
      "editorGutter.background": "#0c0c0f",
      "scrollbarSlider.background": "#26262f88",
      // Diff highlighting tuned to be VIVID so changed regions pop when scrolling
      // fast. Two-tone: a saturated whole-line wash + a stronger inner highlight on
      // the exact changed characters.
      "diffEditor.insertedLineBackground": "#2ea0432e",
      "diffEditor.removedLineBackground": "#f8514929",
      "diffEditor.insertedTextBackground": "#2ea04366",
      "diffEditor.removedTextBackground": "#f8514961",
      // Marks on the right overview ruler — see at a glance WHERE the changes are.
      "diffEditorOverview.insertedForeground": "#2ea043cc",
      "diffEditorOverview.removedForeground": "#f85149cc",
    },
  });
}

/** Configure Monaco's workers + theme once. Safe to call from every editor. */
export function setupMonaco() {
  setupWorkers();
  setupTheme();
}
