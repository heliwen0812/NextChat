import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  console.log("[Google Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  const bearToken =
    req.headers.get("x-goog-api-key") || req.headers.get("Authorization") || "";
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();

  const apiKey = token ? token : serverConfig.googleApiKey;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: true,
        message: `missing GOOGLE_API_KEY in server env vars`,
      },
      {
        status: 401,
      },
    );
  }
  try {
    const response = await request(req, apiKey);
    return response;
  } catch (e) {
    console.error("[Google] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
export const preferredRegion = [
  "bom1",
  "cle1",
  "cpt1",
  "gru1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
];

async function request(req: NextRequest, apiKey: string) {
  const controller = new AbortController();

  let baseUrl = serverConfig.googleUrl || GEMINI_BASE_URL;

  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Google, "");

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );
  const fetchUrl = `${baseUrl}${path}${
    req?.nextUrl?.searchParams?.get("alt") === "sse" ? "?alt=sse" : ""
  }`;
  
  console.log("[Fetch Url] ", fetchUrl);

  let body: any = null;
  try {
    body = await req.json();
  } catch (e) {
    // If the body is not a valid JSON, we ignore it.
    console.warn("[request] body is not a valid JSON, ignoring it.");
    body = null;
  }

  // Add tools to the request body if it doesn't exist. This enables Google Search.
  if (body && !body.tools) {
    body.tools = [{ googleSearch: {} }]
  }

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key": apiKey,
    },
    method: req.method,
    body: body ? JSON.stringify(body) : null,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    const contentType = res.headers.get("Content-Type") || "";
    
    // 处理流式响应（思考过程）
    if (contentType.includes("text/event-stream")) {
      const stream = new ReadableStream({
        async start(controller) {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let functionCallBuffer = "";
          
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");
            
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              
              try {
                const jsonStr = line.replace("data: ", "");
                const eventData = JSON.parse(jsonStr);
                
                // 提取functionCall中间步骤
                if (eventData.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
                  const functionCall = eventData.candidates[0].content.parts[0].functionCall;
                  const thoughtData = {
                    type: "functionCall",
                    name: functionCall.name,
                    args: functionCall.args
                  };
                  
                  // 将思考步骤转换为前端可识别的格式
                  const formattedData = `data: ${JSON.stringify(thoughtData)}\n\n`;
                  controller.enqueue(new TextEncoder().encode(formattedData));
                }
                // 提取文本响应
                else if (eventData.candidates?.[0]?.content?.parts?.[0]?.text) {
                  const textContent = {
                    type: "text",
                    text: eventData.candidates[0].content.parts[0].text
                  };
                  
                  const formattedData = `data: ${JSON.stringify(textContent)}\n\n`;
                  controller.enqueue(new TextEncoder().encode(formattedData));
                }
              } catch (e) {
                console.error("Error parsing event data:", e);
              }
            }
          }
          controller.close();
        }
      });
      
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    } 
    // 处理普通JSON响应
    else {
      const json = await res.json();
      
      // 提取思考过程（functionCall）
      if (json.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
        const functionCall = json.candidates[0].content.parts[0].functionCall;
        json.thoughtProcess = {
          type: "functionCall",
          name: functionCall.name,
          args: functionCall.args,
          reasoning: "模型正在调用工具进行思考"
        };
      }
      
      return new Response(JSON.stringify(json), {
        status: res.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
        }
      });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
