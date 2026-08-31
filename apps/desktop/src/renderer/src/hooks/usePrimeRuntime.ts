import { useEffect, useReducer, useState } from "react";
import type { ChatMessage, RuntimeStatus } from "@shared/contracts";
import { reducePrimeEvent } from "../lib/activity";

const seed: ChatMessage[] = [{
  id: "welcome", role: "assistant", createdAt: Date.now(),
  text: "Welcome. I can help define requirements, explore concepts, build, inspect, and release this design.",
}];

export function usePrimeRuntime() {
  const [messages, dispatch] = useReducer(reducePrimeEvent, seed);
  const [status, setStatus] = useState<RuntimeStatus>({ state: "idle", checks: [] });

  useEffect(() => {
    const offEvent = window.piCad.runtime.onEvent((event) => dispatch(event));
    const offStatus = window.piCad.runtime.onStatus(setStatus);
    return () => { offEvent(); offStatus(); };
  }, []);

  const prompt = async (text: string, images?: Array<{ data: string; mimeType: string }>) => {
    dispatch({ type: "desktop_user_message", id: crypto.randomUUID(), text });
    await window.piCad.runtime.prompt(text, images);
  };

  return { messages, status, prompt, start: () => window.piCad.runtime.start(), abort: () => window.piCad.runtime.abort() };
}
