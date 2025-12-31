import { Ai } from '@cloudflare/ai';

export interface Env {
  AI: any;
  DB: D1Database;
  LARK_VERIFICATION_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. 只允许 POST
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    let body: any;
    try {
      body = await request.json();
    } catch (e) {
      return new Response('Invalid JSON', { status: 400 });
    }

    // 2. 飞书 URL 验证 (Challenge)
    if (body.type === 'url_verification') {
      if (body.token !== env.LARK_VERIFICATION_TOKEN) {
        return new Response('Invalid Token', { status: 403 });
      }
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. 打印日志方便调试
    console.log('收到请求:', JSON.stringify(body));

    return new Response('OK', { status: 200 });
  },
};