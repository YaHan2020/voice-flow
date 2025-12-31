export interface Env {
  AI: any;
  DB: D1Database;
  LARK_VERIFICATION_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. 只接受 POST 请求
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      // 2. 解析飞书发来的 JSON 数据
      const body = await request.json() as any;

      // 3. 这里的 'url_verification' 就是飞书在问：“你在吗？暗号对不对？”
      if (body.type === 'url_verification') {
        // 4. 检查暗号 (Token) 是否匹配
        if (body.token !== env.LARK_VERIFICATION_TOKEN) {
          return new Response('Invalid Token', { status: 403 });
        }
        // 5. 暗号正确，把飞书给的 challenge 原样送回去，完成握手
        return new Response(JSON.stringify({ challenge: body.challenge }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 这里后续会加处理消息的逻辑...
      return new Response('OK', { status: 200 });

    } catch (error) {
      // 如果出错了，告诉我们错在哪
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  },
};
