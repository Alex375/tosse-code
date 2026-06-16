mod ipc;

use ipc::commands::ping;
use ipc::events::TickEvent;
use tauri_specta::{collect_commands, collect_events, Builder, Event};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. Declare the IPC contract (commands + events) once.
    let specta_builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![ping])
        .events(collect_events![TickEvent]);

    // 2. Generate the TS client into src/ipc/bindings.ts (debug builds only).
    #[cfg(debug_assertions)]
    specta_builder
        .export(
            // u64/i64 (e.g. timestamps, PIDs, sizes) -> TS `number`. JS-safe
            // below 2^53, which covers ms timestamps. Default behavior forbids
            // BigInt outright; switch to BigInt/String later if a value can exceed 2^53.
            // @ts-nocheck header: the generated file imports helpers it may not use
            // (e.g. TAURI_CHANNEL), which trips our strict noUnusedLocals.
            specta_typescript::Typescript::default()
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                .header("// @ts-nocheck\n"),
            "../src/ipc/bindings.ts",
        )
        .expect("failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 3. Wire commands through tauri-specta (replaces generate_handler!).
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            // Mount the Specta events on this app instance (REQUIRED for events).
            specta_builder.mount_events(app);

            // 4. Rust timer: emit a TickEvent every second (Rust -> React).
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
                    // Proof of the outbound leg (Rust -> React) on stdout.
                    println!("[ipc] emitting TickEvent seq={seq}");
                    if TickEvent::emit(&ev, &handle).is_err() {
                        break; // window closed
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tosse-code");
}
