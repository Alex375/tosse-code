mod ipc;
pub mod store;
pub mod supervisor;

use ipc::commands::{
    answer_permission, delete_conversation, delete_repo, interrupt_session, load_persisted_state,
    load_session_history, open_in_terminal, ping, send_message, set_active_conversation,
    set_effort_level, set_model, set_permission_mode, spawn_session, stop_session,
    upsert_conversation, upsert_repo, wipe_all_data, Sessions,
};
use ipc::events::{SessionMessageEvent, SessionPermissionEvent, SessionStateEvent, TickEvent};
use tauri_specta::{collect_commands, collect_events, Builder, Event};

/// Declare the IPC contract (commands + events) once. Shared by `run()` and the
/// TS-bindings export so they can never drift.
fn ipc_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            ping,
            spawn_session,
            load_session_history,
            send_message,
            answer_permission,
            set_permission_mode,
            set_model,
            set_effort_level,
            interrupt_session,
            stop_session,
            open_in_terminal,
            load_persisted_state,
            upsert_repo,
            delete_repo,
            upsert_conversation,
            delete_conversation,
            set_active_conversation,
            wipe_all_data,
        ])
        .events(collect_events![
            TickEvent,
            SessionStateEvent,
            SessionMessageEvent,
            SessionPermissionEvent,
        ])
}

/// Export the typed TS client into `src/ipc/bindings.ts`. Used by `run()` in
/// debug builds and by the `export_bindings_is_in_sync` test.
#[cfg(debug_assertions)]
fn export_bindings(builder: &Builder<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    builder.export(
        // u64/i64 (e.g. timestamps, PIDs, sizes) -> TS `number`. JS-safe below
        // 2^53, which covers ms timestamps. Default behavior forbids BigInt
        // outright; switch to BigInt/String later if a value can exceed 2^53.
        // @ts-nocheck header: the generated file imports helpers it may not use
        // (e.g. TAURI_CHANNEL), which trips our strict noUnusedLocals.
        specta_typescript::Typescript::default()
            .bigint(specta_typescript::BigIntExportBehavior::Number)
            .header("// @ts-nocheck\n"),
        "../src/ipc/bindings.ts",
    )?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = ipc_builder();

    // Generate the TS client into src/ipc/bindings.ts (debug builds only).
    #[cfg(debug_assertions)]
    export_bindings(&specta_builder).expect("failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Wire commands through tauri-specta (replaces generate_handler!).
        .invoke_handler(specta_builder.invoke_handler())
        // The live session registry, reachable from every command.
        .manage(Sessions::new())
        .setup(move |app| {
            use tauri::Manager;

            // Mount the Specta events on this app instance (REQUIRED for events).
            specta_builder.mount_events(app);

            // Open the persistence store in the app data dir (created if absent).
            // The store is the single owner of SQLite; the rest of the core and
            // the UI see domain records via IPC, never rows. dev and the bundled
            // app share the same identifier -> the same db -> a unified list.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir available");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");
            let store = store::Store::open(&data_dir.join("tosse.db"))
                .expect("failed to open the persistence store");
            // Backfill activity timestamps for conversations created before the
            // `last_activity_at` column existed, so the sidebar's recency order is
            // correct for historical conversations on first launch. The transcript
            // mtime is the proxy for "last message"; created_at is the fallback.
            // No-op once every row is filled (best-effort: a failure here must not
            // block startup — the sidebar simply keeps the unbackfilled order).
            if let Err(e) =
                store.backfill_last_activity(supervisor::history::transcript_mtime_ms)
            {
                eprintln!("last_activity_at backfill failed: {e}");
            }
            app.manage(store);

            // Rust timer: emit a TickEvent every second (Rust -> React) — kept as
            // a heartbeat / proof of the outbound event leg.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut seq = 0u32;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    seq += 1;
                    let ev = TickEvent {
                        seq,
                        message: format!("tick #{seq}"),
                    };
                    if TickEvent::emit(&ev, &handle).is_err() {
                        break; // window closed
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tosse-code")
        .run(|app_handle, event| {
            // On app exit, tear every live session down so we never orphan a
            // `claude` child (nor any of its tool/MCP grandchildren — each session
            // runs in its own process group and the actor's ladder signals the
            // whole group; see `supervisor::transport`). Request shutdown on every
            // session, then wait until the registry drains — each actor evicts
            // itself once its process is reaped — capped so quit never hangs.
            if let tauri::RunEvent::Exit = event {
                use std::time::{Duration, Instant};
                use tauri::Manager;
                let sessions = app_handle.state::<Sessions>();
                let handles = sessions.handles();
                if !handles.is_empty() {
                    tauri::async_runtime::block_on(async {
                        for handle in &handles {
                            let _ = handle.shutdown().await;
                        }
                        let deadline = Duration::from_secs(6);
                        let start = Instant::now();
                        while !sessions.is_empty() && start.elapsed() < deadline {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    });
                }
            }
        });
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;

    /// Regenerate `src/ipc/bindings.ts` from the live IPC contract. Running the
    /// test suite keeps the committed TS bindings in sync with the Rust types.
    #[test]
    fn export_bindings_regenerates_ts_client() {
        export_bindings(&ipc_builder()).expect("bindings export should succeed");
    }
}
