export interface Env {
  AI: any;
  DB: D1Database;
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
      const body = await request.json() as any;

      // 1. 飞书验证
      if (body.type === 'url_verification') {
        if (body.token !== env.LARK_VERIFICATION_TOKEN) return new Response('Invalid Token', { status: 403 });
        return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 2. 接收消息
      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const messageId = body.event.message.message_id;
        const msgType = body.event.message.message_type;
        const content = JSON.parse(body.event.message.content);
        
        ctx.waitUntil(handleMessage(env, messageId, msgType, content));
        return new Response('OK', { status: 200 });
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  },
};

// --- 核心业务逻辑 ---
async function handleMessage(env: Env, messageId: string, msgType: string, content: any) {
  // 1. 获取 Token
  const token = await getLarkToken(env.LARK_APP_ID, env.LARK_APP_SECRET);
  if (!token) {
    console.error("Token 获取失败");
    return;
  }

  if (msgType === 'text') {
    await replyLark(token, messageId, `📝 收到文字：${content.text}`);
  
  } else if (msgType === 'audio') {
    // 2. 收到语音
    await replyLark(token, messageId, "👂 正在下载语音..."); 
    
    const fileKey = content.file_key;
    console.log(`开始下载文件: ${fileKey}`);

    // 3. 尝试下载
    const audioBlob = await downloadLarkFile(token, messageId, fileKey);

    if (!audioBlob) {
      // ⚠️ 如果下载失败，这里会直接告诉您原因
      await replyLark(token, messageId, "❌ 下载语音失败！可能是权限不足或文件已过期。请查看 Cloudflare 日志。");
      return;
    }

    // 4. 开始转录
    try {
      // 更新状态提示
      // await replyLark(token, messageId, "🤖 正在进行 AI 转录..."); // 可选，调试用
      
      const response = await env.AI.run('@cf/openai/whisper', {
        audio: [...new Uint8Array(await audioBlob.arrayBuffer())]
      });
      
      const finalTextInput = response.text;
      
      if (!finalTextInput) {
         await replyLark(token, messageId, "❌ AI 转录结果为空");
         return;
      }

      // 5. 成功返回
      await replyLark(token, messageId, `🎙️ 识别结果：\n${finalTextInput}`);

    } catch (err) {
      console.error("AI 报错:", err);
      // ⚠️ 如果 AI 报错，这里会把具体错误发出来
      await replyLark(token, messageId, `❌ AI 报错: ${err.message}`);
    }
  } else {
    await replyLark(token, messageId, "暂不支持此消息类型");
  }
}

// --- 工具函数 ---
async function getLarkToken(appId: string, appSecret: string) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "app_id": appId, "app_secret": appSecret })
  });
  const data: any = await res.json();
  return data.tenant_access_token;
}

async function replyLark(token: string, messageId: string, text: string) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ "msg_type": "text", "content": JSON.stringify({ "text": text }) })
  });
}

// --- 下载逻辑 (带详细报错) ---
async function downloadLarkFile(token: string, messageId: string, fileKey: string) {
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;
  
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`飞书下载接口报错: ${response.status} - ${errorText}`);
    return null;
  }
  return await response.blob();
}
