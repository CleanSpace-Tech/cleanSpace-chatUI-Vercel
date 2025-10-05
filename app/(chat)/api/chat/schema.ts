import { z } from "zod";

const textPartSchema = z.object({
  type: z.enum(["text"]),
  text: z.string().min(1).max(2000),
});

const filePartSchema = z.object({
  type: z.enum(["file"]),
  mediaType: z.enum(["image/jpeg", "image/png"]),
  name: z.string().min(1).max(100),
  url: z.string().url(),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

// Add conversation message schema
const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
  timestamp: z.string().datetime().optional(), // ISO string format
});

// Add conversation state schema
const conversationStateSchema = z.object({
  messages: z.array(conversationMessageSchema).default([]),
  lastResponseId: z.string().optional(),
  conversationId: z.string().optional(),
});

export const postRequestBodySchema = z.object({
  id: z.string().uuid(),
  message: z.object({
    id: z.string().uuid(),
    role: z.enum(["user"]),
    parts: z.array(partSchema),
  }),
  selectedChatModel: z.enum(["chat-model", "chat-model-reasoning"]),
  selectedVisibilityType: z.enum(["public", "private"]),
  previousResponseId: z.string().optional()

  // // Alternative approach: individual optional fields (if you prefer this structure)
  // conversationHistory: z.array(conversationMessageSchema).optional(),
  // previousResponseId: z.string().optional(),
  // conversationId: z.string().optional(),

});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;

// // Export additional types for better type safety
// export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationState = z.infer<typeof conversationStateSchema>;
