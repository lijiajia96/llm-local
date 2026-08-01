export type Role = "system" | "user" | "assistant";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = TextPart | ImagePart;

export type ChatMessage = {
  role: Role;
  content: string | ContentPart[];
};

export type ChatCompletionChunk = {
  choices?: Array<{ delta?: { content?: string } }>;
};

export type ConnectionState = "idle" | "ok" | "bad";

export type TraceBlockKind =
  | "thought"
  | "action"
  | "action_input"
  | "observation"
  | "final_answer";

export type TraceBlock = { kind: TraceBlockKind; text: string };
