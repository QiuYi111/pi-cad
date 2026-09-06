export function automaticConversationTitle(prompt: string) {
  const text = prompt.replace(/\s+/g, " ").trim().replace(/^(?:hi|hello|hey|你好|您好)[,，!！:\s]*/i, "");
  if (!text) return "新对话";
  const sentence = text.split(/(?<=[。！？.!?])\s*/u)[0] || text;
  if (sentence.length <= 36) return sentence;
  const clipped = sentence.slice(0, 35).trimEnd();
  const clean = /[A-Za-z0-9]$/.test(clipped) ? clipped.replace(/\s+\S*$/, "") || clipped : clipped;
  return `${clean}…`;
}

export function needsAutomaticConversationTitle(title: string, id: string) {
  const value = title.trim();
  return !value || value === id || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) || /^(?:session|conversation|untitled)(?:[-_ ].*)?$/i.test(value);
}
