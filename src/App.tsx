import { useEffect, useState } from "react";
import { commands, events } from "./ipc/client";
import type { Pong, TickEvent } from "./ipc/client";

export default function App() {
  const [pong, setPong] = useState<Pong | null>(null);
  const [lastTick, setLastTick] = useState<TickEvent | null>(null);

  useEffect(() => {
    // A) React -> Rust: typed command, on mount.
    commands.ping("boot").then((res) => {
      console.log("[ipc] ping ->", res);
      setPong(res);
    });

    // B) Rust -> React: subscribe to the typed event.
    const unlistenPromise = events.tickEvent.listen((e) => {
      console.log("[ipc] tick <-", e.payload);
      setLastTick(e.payload);
    });

    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>Tosse Code — IPC smoke test</h1>
      <p data-testid="pong">
        ping →{" "}
        {pong ? `ok=${pong.ok} echo=${pong.echo} at=${pong.at_ms}` : "…"}
      </p>
      <p data-testid="tick">
        TickEvent →{" "}
        {lastTick ? `seq=${lastTick.seq} "${lastTick.message}"` : "en attente…"}
      </p>
    </main>
  );
}
