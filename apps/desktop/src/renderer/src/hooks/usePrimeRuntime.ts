import { useEffect, useReducer, useRef, useState } from "react";
import type { ChatMessage, RuntimeStatus } from "@shared/contracts";
import { reducePrimeEvent } from "../lib/activity";

const seed: ChatMessage[] = [{
  id: "welcome", role: "assistant", createdAt: Date.now(),
  text: "Welcome. I can help define requirements, explore concepts, build, inspect, and release this design.",
}];

export function usePrimeRuntime() {
  const [messages, dispatch] = useReducer(reducePrimeEvent, seed);
  const [status, setStatus] = useState<RuntimeStatus>({ state: "idle", checks: [] });
  const eventQueue = useRef<unknown[]>([]);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    const offEvent = window.piCad.runtime.onEvent((event) => {
      eventQueue.current.push(event);
      if (frame.current !== undefined) return;
      frame.current = window.requestAnimationFrame(() => {
        frame.current = undefined;
        const events = eventQueue.current.splice(0);
        dispatch({ type: "desktop_event_batch", events });
      });
    });
    const offStatus = window.piCad.runtime.onStatus(setStatus);
    return () => { offEvent(); offStatus(); if (frame.current !== undefined) window.cancelAnimationFrame(frame.current); };
  }, []);

  const prompt = async (text: string, images?: Array<{ data: string; mimeType: string }>, prepare?: () => Promise<void>) => {
    dispatch({ type: "desktop_user_message", id: crypto.randomUUID(), text });
    dispatch({ type: "desktop_agent_pending" });
    try {
      await prepare?.();
      await window.piCad.runtime.prompt(text, images);
    }
    catch (error) {
      dispatch({ type: "desktop_agent_error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  return { messages, status, prompt, start: () => window.piCad.runtime.start(), stop: () => window.piCad.runtime.stop(), abort: () => window.piCad.runtime.abort() };
}
