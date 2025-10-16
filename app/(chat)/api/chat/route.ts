import { geolocation } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from "ai";
import { unstable_cache as cache } from "next/cache";
import { after } from "next/server";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream";
import type { ModelCatalog } from "tokenlens/core";
import { fetchModels } from "tokenlens/fetch";
import { getUsage } from "tokenlens/helpers";
import { auth, type UserType } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/visibility-selector";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import type { ChatModel } from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { myProvider } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatLastContextById,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import type { AppUsage } from "@/lib/usage";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";
import error from "next/error";


export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

const getTokenlensCatalog = cache(
  async (): Promise<ModelCatalog | undefined> => {
    try {
      return await fetchModels();
    } catch (err) {
      console.warn(
        "TokenLens: catalog fetch failed, using default catalog",
        err
      );
      return; // tokenlens helpers will fall back to defaultCatalog
    }
  },
  ["tokenlens-catalog"],
  { revalidate: 24 * 60 * 60 } // 24 hours
);

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes("REDIS_URL")) {
        console.log(
          " > Resumable streams are disabled due to missing REDIS_URL"
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}


export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
    console.log("This is Request Body____:");
    console.log(requestBody);

    // ✅ Extract REAL chatId from request
    const chatId = requestBody.id; // This is the chat/conversation ID
    console.log("💬 Chat ID:", chatId);

    // ✅ Extract REAL message ID from the incoming message
    const messageId = requestBody.message.id;
    console.log("📝 Message ID:", messageId);

    // Extract user message
    let userMessage: string | undefined;
    if (requestBody.message.parts[0].type === "text") {
      userMessage = requestBody.message.parts[0].text;
      console.log("User message extracted:", userMessage);
    } else {
      throw new Error("No text found in the message");
    }    

    // Get conversation state from request
    const previousResponseId = requestBody.previousResponseId;
    console.log("user sent new message's Previous Response ID:", previousResponseId);

    // call custom backend
    const backendURL = process.env.BACKEND_URL || 'http://localhost:8001';
    if (!backendURL) {
      throw new Error("Backend URL is not defined");
    }
    const backendResponse = await fetch(`${backendURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        {
          "messages": [
            {
              "id": messageId,
              "role": "user",
              "content": userMessage
            }
          ],
          "conversation_id": chatId
        }
      ),
    });
    
    if (!backendResponse.ok) {
      throw new Error(`Backend error: ${backendResponse.status}`);
    }


    // Create stream that reads from backend
    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const messageId = generateUUID();
        let fullText = '';

        dataStream.write({
          type: 'text-start',
          id: messageId,
          providerMetadata: undefined
        });

        // Read the stream from backend
        const reader = backendResponse.body?.getReader();
        const decoder = new TextDecoder();

        if (reader) {
          let buffer = '';
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            
            // Split by newlines
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line

            for (const line of lines) {
              if (!line.trim()) continue;

              console.log('📦 Line:', line);

              // Match Flask format: "0:{...}" or "d:{...}"
              const match = line.match(/^(\d+|d):(.+)$/);
              if (!match) continue;

              const [, type, data] = match;

              try {
                const parsed = JSON.parse(data);

                if (type === '0' && parsed.type === 'text-delta' && parsed.textDelta) {
                  fullText += parsed.textDelta;
                  
                  dataStream.write({
                    type: 'text-delta',
                    id: messageId,
                    delta: parsed.textDelta
                  });
                  
                  console.log('✍️ Wrote:', parsed.textDelta);
                } 
                else if (type === 'd' && parsed.finishReason === 'stop') {
                  console.log('🏁 Finished');
                }
              } catch (e) {
                console.error('Parse error:', line, e);
              }
            }
          }
        }

        dataStream.write({
          type: 'text-end',
          id: messageId
        });

        dataStream.write({
          type: 'data-usage',
          id: messageId,
          data: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            responseId: 'test-001' // Use conversation_id or generate new one
          }
        });
      },
      generateId: generateUUID,
    });

    return new Response(stream.pipeThrough(new JsonToSseTransformStream()));



    

    



  } catch (_) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
