export type Role = "user" | "assistant";

export interface ToolTrace {
  id: string;
  name: string;
  summary: string;
  status: "done" | "error" | "awaiting-approval" | "rejected";
  result?: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  trace?: ToolTrace[];
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
}
