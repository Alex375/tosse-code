// Subscribe a component to one session's event streams and feed the store.
//
// Performance: text_delta / thinking_delta are the highest-frequency events. We
// accumulate them in a ref and flush to Zustand on a single requestAnimationFrame
// tick (~16-33ms), capping re-renders at one frame regardless of token rate and
// preventing markdown re-parse / Shiki re-highlight storms. Every other item is
// applied immediately (after flushing pending deltas, to preserve arrival order).

import { useEffect } from "react";
import { events } from "./client";
import type {
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionStateEvent,
} from "./client";
import { useConversationStore } from "../store/conversationStore";
import { useConversationsStore } from "../store/conversationsStore";

export function useSessionEvents(session: string): void {
  useEffect(() => {
    if (!session) return;

    const {
      ensureSession,
      applyState,
      applyItem,
      appendText,
      appendThinking,
      enqueuePermission,
    } = useConversationStore.getState();

    ensureSession(session);

    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const pending = new Map<string, { text: string; thinking: string }>();
    let rafId = 0;
    let currentMessageId: string | null = null;

    const flush = () => {
      rafId = 0;
      if (pending.size === 0) return;
      pending.forEach((buf, msgId) => {
        if (buf.text) appendText(session, msgId, buf.text);
        if (buf.thinking) appendThinking(session, msgId, buf.thinking);
      });
      pending.clear();
    };
    const scheduleFlush = () => {
      if (!rafId) rafId = requestAnimationFrame(flush);
    };

    const onMessage = (payload: SessionMessageEvent) => {
      if (payload.session !== session) return; // demux
      const item = payload.item;

      if (item.kind === "text_delta" || item.kind === "thinking_delta") {
        const msgId = item.message_id ?? currentMessageId;
        if (!msgId) return;
        const buf = pending.get(msgId) ?? { text: "", thinking: "" };
        if (item.kind === "text_delta") buf.text += item.text;
        else buf.thinking += item.text;
        pending.set(msgId, buf);
        scheduleFlush();
        return;
      }

      if (item.kind === "message_started" && item.parent_tool_use_id === null) {
        currentMessageId = item.id;
      }
      // Non-delta item: preserve order by flushing buffered deltas first.
      flush();
      applyItem(session, item);
    };

    const onState = (payload: SessionStateEvent) => {
      if (payload.session !== session) return;
      applyState(session, payload.state);
      // Capture the claude session_id from system/init so we can --resume on restart.
      if (payload.state.session_id) {
        useConversationsStore.getState().noteSessionId(session, payload.state.session_id);
      }
    };

    const onPermission = (payload: SessionPermissionEvent) => {
      if (payload.session !== session) return;
      enqueuePermission(session, payload.request);
    };

    events.sessionMessageEvent
      .listen((e) => {
        if (!disposed) onMessage(e.payload);
      })
      .then((un) => unlisteners.push(un));
    events.sessionStateEvent
      .listen((e) => {
        if (!disposed) onState(e.payload);
      })
      .then((un) => unlisteners.push(un));
    events.sessionPermissionEvent
      .listen((e) => {
        if (!disposed) onPermission(e.payload);
      })
      .then((un) => unlisteners.push(un));

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      flush();
      unlisteners.forEach((un) => un());
    };
  }, [session]);
}
