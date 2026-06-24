// Top-of-app banner for app-level errors (boot/hydration, metadata persistence).
// Sits beside the UpdateBanner in the window's banner slot. Each error is
// dismissible; the technical detail sits under the message in a muted line.
import { useAppErrors } from "../store/appErrors";
import { Ico } from "./kit";

export function AppErrorBanner() {
  const errors = useAppErrors((s) => s.errors);
  const dismiss = useAppErrors((s) => s.dismiss);
  if (errors.length === 0) return null;

  return (
    <>
      {errors.map((e) => (
        <div
          key={e.id}
          role="alert"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "8px 12px",
            background: "color-mix(in srgb, var(--wf-err) 14%, var(--wf-bg, transparent))",
            borderBottom: "1px solid var(--wf-err)",
            color: "var(--wf-tx)",
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          <span style={{ color: "var(--wf-err)", flex: "none", marginTop: 1, display: "inline-flex" }}>
            <Ico name="alert" className="sm" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{e.message}</div>
            {e.detail ? (
              <div style={{ marginTop: 2, fontSize: 11, color: "var(--wf-tx-lo)", wordBreak: "break-word" }}>
                {e.detail}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => dismiss(e.id)}
            title="Masquer"
            style={{
              flex: "none",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--wf-tx-lo)",
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}
