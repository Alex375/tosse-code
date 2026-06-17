// Global session event subscriber — registered ONCE at App mount and never torn
// down. Routing all events through a single persistent listener eliminates the
// race condition where Claude starts replaying history before a per-component
// listener has finished its async `listen()` calls.
//
// Coalescing: text/thinking deltas are buffered per (session, messageId) and
// flushed on a single rAF tick, keeping re-renders at one frame per token burst.

import { useEffect } from "react";
import { events } from "./client";
import type {
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionStateEvent,
} from "./client";
import { useConversationStore } from "../store/conversationStore";
import { useConversationsStore } from "../store/conversationsStore";

interface DeltaBuf {
  text: string;
  thinking: string;
}

export function useGlobalSessionEvents(): void {
  useEffect(() => {
    // Per-(session,messageId) delta buffers.
    const pending = new Map<string, DeltaBuf>();
    // Current open message id per session (for deltas without explicit message_id).
    const currentMsgId = new Map<string, string>();
    const rafIds = new Map<string, number>();
    // Sessions already ensured in the store (avoid redundant state writes).
    const ensured = new Set<string>();
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    function ensureOnce(session: string) {
      if (ensured.has(session)) return;
      ensured.add(session);
      useConversationStore.getState().ensureSession(session);
    }

    function flushKey(bufKey: string, session: string, msgId: string) {
      rafIds.delete(bufKey);
      const buf = pending.get(bufKey);
      if (!buf) return;
      pending.delete(bufKey);
      const { appendText, appendThinking } = useConversationStore.getState();
      if (buf.text) appendText(session, msgId, buf.text);
      if (buf.thinking) appendThinking(session, msgId, buf.thinking);
    }

    function scheduleFlush(session: string, msgId: string) {
      const key = `${session}:${msgId}`;
      if (!rafIds.has(key)) {
        rafIds.set(key, requestAnimationFrame(() => flushKey(key, session, msgId)));
      }
    }

    function onMessage(payload: SessionMessageEvent) {
      const session = payload.session;
      const item = payload.item;
      ensureOnce(session);

      if (item.kind === "text_delta" || item.kind === "thinking_delta") {
        const msgId = item.message_id ?? currentMsgId.get(session);
        if (!msgId) return;
        const key = `${session}:${msgId}`;
        const buf = pending.get(key) ?? { text: "", thinking: "" };
        if (item.kind === "text_delta") buf.text += item.text;
        else buf.thinking += item.text;
        pending.set(key, buf);
        scheduleFlush(session, msgId);
        return;
      }

      // Non-delta: flush buffered deltas for the CURRENTLY open message first, so
      // its streamed text lands before this item is applied — and BEFORE a new
      // message_started switches currentMsgId, otherwise the old message's tail
      // would be left dangling in its buffer.
      const openMsgId = currentMsgId.get(session);
      if (openMsgId) {
        const key = `${session}:${openMsgId}`;
        const rafId = rafIds.get(key);
        if (rafId) cancelAnimationFrame(rafId);
        flushKey(key, session, openMsgId);
      }

      if (item.kind === "message_started" && item.parent_tool_use_id === null) {
        currentMsgId.set(session, item.id);
      }

      useConversationStore.getState().applyItem(session, item);
    }

    function onState(payload: SessionStateEvent) {
      const session = payload.session;
      ensureOnce(session);
      useConversationStore.getState().applyState(session, payload.state);
      if (payload.state.session_id) {
        useConversationsStore.getState().noteSessionId(session, payload.state.session_id);
      }
    }

    function onPermission(payload: SessionPermissionEvent) {
      const session = payload.session;
      ensureOnce(session);
      useConversationStore.getState().enqueuePermission(session, payload.request);
    }

    events.sessionMessageEvent
      .listen((e) => { if (!disposed) onMessage(e.payload); })
      .then((un) => unlisteners.push(un));
    events.sessionStateEvent
      .listen((e) => { if (!disposed) onState(e.payload); })
      .then((un) => unlisteners.push(un));
    events.sessionPermissionEvent
      .listen((e) => { if (!disposed) onPermission(e.payload); })
      .then((un) => unlisteners.push(un));

    return () => {
      disposed = true;
      rafIds.forEach((id) => cancelAnimationFrame(id));
      unlisteners.forEach((un) => un());
    };
  }, []); // Empty deps: registers ONCE at App mount, never re-registers.
}
