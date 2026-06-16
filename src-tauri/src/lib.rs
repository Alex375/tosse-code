mod ipc;
pub mod supervisor;

use ipc::commands::{
    answer_permission, interrupt_session, ping, send_message, set_permission_mode, spawn_session,
    stop_session, Sessions,
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
            send_message,
            answer_permission,
            set_permission_mode,
            interrupt_session,
            stop_session,
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
        // Wire commands through tauri-specta (replaces generate_handler!).
        .invoke_handler(specta_builder.invoke_handler())
        // The live session registry, reachable from every command.
        .manage(Sessions::new())
        .setup(move |app| {
            // Mount the Specta events on this app instance (REQUIRED for events).
            specta_builder.mount_events(app);

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
            // `claude` child. Best-effort and bounded: request shutdown on each,
            // then give the actor tasks (running on the runtime's worker threads)
            // a short window to run their EOF→kill ladder before the process
            // stops. A per-child process-group kill is the stronger future
            // guarantee (see docs §2.5).
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let handles = app_handle.state::<Sessions>().drain();
                if !handles.is_empty() {
                    tauri::async_runtime::block_on(async {
                        for handle in &handles {
                            let _ = handle.shutdown().await;
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
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
