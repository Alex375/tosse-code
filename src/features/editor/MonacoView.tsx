// The Monaco editor wrapper. This module is the heavy one (Monaco + its language
// grammars), so it is imported LAZILY (React.lazy in EditorPane) — it lands in
// its own chunk and never weighs on app startup, keeping the "fast/light" core
// principle intact.
//
// Workers: Vite bundles each as its own lazily-fetched chunk, so they cost
// nothing at startup (the whole editor is already a lazy import) and only load
// when a file of that language is opened. We wire the standard set so opening a
// .ts/.json/.css/.html file doesn't hand the language service the wrong worker
// (which would error); everything else falls back to the base editor worker.
// Syntax highlighting itself runs on the main thread (Monarch), needing no worker.

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import styles from "./editor.module.css";

type MonacoSelf = typeof globalThis & { MonacoEnvironment?: monaco.Environment };
const globalSelf = globalThis as MonacoSelf;
if (!globalSelf.MonacoEnvironment) {
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

let themeDefined = false;
function ensureTheme() {
  if (themeDefined) return;
  themeDefined = true;
  // Mirror the app's dark palette (--wf-* tokens) so the editor blends in.
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
    },
  });
}

interface Props {
  path: string;
  value: string;
  language: string;
  /** All currently-open tab paths — models for closed tabs are disposed. */
  openPaths: string[];
  onChange: (value: string) => void;
  onSave: () => void;
}

export default function MonacoView({ path, value, language, openPaths, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  // Guards the change listener while we apply an EXTERNAL value (live reload), so
  // pushing disk content into the model doesn't echo back as a user edit.
  const applyingExternal = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Create the editor exactly once.
  useEffect(() => {
    ensureTheme();
    const ed = monaco.editor.create(hostRef.current!, {
      theme: "tosse-dark",
      automaticLayout: true, // tracks our resizable panel via a ResizeObserver
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: "none",
      smoothScrolling: true,
      padding: { top: 8 },
      scrollbar: { useShadows: false },
    });
    editorRef.current = ed;
    const sub = ed.onDidChangeModelContent(() => {
      if (applyingExternal.current) return;
      const m = ed.getModel();
      if (m) onChangeRef.current(m.getValue());
    });
    // Cmd/Ctrl+S → save now (in addition to the debounced autosave).
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    return () => {
      sub.dispose();
      ed.dispose();
      editorRef.current = null;
      models.current.forEach((m) => m.dispose());
      models.current.clear();
    };
  }, []);

  // Bind the active path's model (created + cached per file, so switching tabs
  // preserves each file's undo history and cursor position).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const uri = monaco.Uri.file(path);
    let model = models.current.get(path);
    if (!model) {
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, language, uri);
      models.current.set(path, model);
    }
    if (ed.getModel() !== model) ed.setModel(model);
    // `value`/`language` are intentionally not deps: handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Push external value changes (live reload / first load) into the model.
  useEffect(() => {
    const model = models.current.get(path);
    if (!model || model.getValue() === value) return;
    applyingExternal.current = true;
    model.setValue(value);
    applyingExternal.current = false;
  }, [value, path]);

  // Keep the model's language in sync.
  useEffect(() => {
    const model = models.current.get(path);
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language, path]);

  // Dispose models for tabs that were closed (free memory).
  useEffect(() => {
    const keep = new Set(openPaths);
    for (const [p, m] of models.current) {
      if (!keep.has(p)) {
        m.dispose();
        models.current.delete(p);
      }
    }
  }, [openPaths]);

  return <div ref={hostRef} className={styles.monacoHost} />;
}
