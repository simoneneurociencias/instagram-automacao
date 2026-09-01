// Cliente da API do Instagram com Login do Instagram (graph.instagram.com).
//
// Por que existe, além do client.js:
// A Meta tem dois caminhos para a mesma conta. O antigo passa pelo Login do
// Facebook e pela Página (graph.facebook.com); o novo fala direto com o
// Instagram. Em 31/08/2026 medimos que o caminho antigo:
//   - recusa o envio de mensagem com "(#3) Application does not have the capability"
//   - não devolve o autor do comentário
//   - só entrega 2 conversas do Direct por consulta, e recusa paginação
// O caminho novo faz as três coisas sem reclamar. Por isso a automação usa este.
//
// A interface pública é a mesma do IGClient, para o motor não precisar saber
// por qual caminho está falando.

import { loadEnv } from './client.js';

export class IGLoginClient {
  constructor(env = loadEnv()) {
    this.token = env.IG_ACCESS_TOKEN;
    this.version = env.GRAPH_VERSION || 'v23.0';
    this.base = `https://graph.instagram.com/${this.version}`;
    this.igUserId = env.IG_USER_ID;
    if (!this.token) {
      throw new Error(
        'IG_ACCESS_TOKEN ausente no .env. Gere em: painel do app → Casos de uso →\n' +
          'Gerenciar mensagens e conteúdo no Instagram → Configuração da API com login\n' +
          'do Instagram → Gerar token.'
      );
    }
  }

  async request(path, { method = 'GET', params = {}, body = null } = {}) {
    const url = new URL(`${this.base}/${path}`);
    url.searchParams.set('access_token', this.token);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const opts = { method };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (data?.error) {
      const err = new Error(`Instagram API erro: ${data.error.message}`);
      err.details = data;
      throw err;
    }
    if (!res.ok) throw new Error(`Instagram API erro: HTTP ${res.status}`);
    return data;
  }

  async whoami() {
    return this.request('me', {
      params: { fields: 'user_id,username,name,followers_count,media_count,profile_picture_url' },
    });
  }

  async listMedia(limit = 10) {
    const d = await this.request('me/media', {
      params: { fields: 'id,caption,media_type,permalink,timestamp,comments_count,like_count', limit },
    });
    return d.data || [];
  }

  /** O autor vem em `from`; copiamos para `username` para casar com o formato antigo. */
  async listComments(mediaId, limit = 50) {
    const d = await this.request(`${mediaId}/comments`, {
      params: { fields: 'id,text,timestamp,like_count,from{id,username}', limit },
    });
    return (d.data || []).map((c) => ({ ...c, username: c.username || c.from?.username }));
  }

  async replyToComment(commentId, message) {
    return this.request(`${commentId}/replies`, { method: 'POST', params: { message } });
  }

  async hideComment(commentId, hide = true) {
    return this.request(commentId, { method: 'POST', params: { hide } });
  }

  async listConversations(limit = 20) {
    const d = await this.request('me/conversations', {
      params: {
        fields: 'id,updated_time,messages.limit(1){id,message,from,created_time}',
        limit,
      },
    });
    return d.data || [];
  }

  async listMessages(conversationId, limit = 20) {
    const d = await this.request(conversationId, {
      params: { fields: `messages.limit(${limit}){id,message,from,to,created_time}` },
    });
    return d.messages?.data || [];
  }

  /** Resposta privada: Direct para quem comentou. Uma vez por comentário. */
  async privateReplyToComment(commentId, text) {
    return this.request('me/messages', {
      method: 'POST',
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
  }

  /**
   * Cartão com botão (generic template). No Direct aparece como um card com
   * imagem, título e um botão que abre a URL, em vez de um link solto no texto.
   *
   * Limites da Meta: título até 80 caracteres, subtítulo até 80, no máximo 3
   * botões. A imagem precisa estar numa URL pública.
   *
   * O destinatário é { id } para conversa aberta ou { comment_id } para
   * resposta privada a um comentário.
   */
  async sendCard(recipient, { titulo, subtitulo, imagem, url, botao }) {
    const elemento = { title: titulo };
    if (subtitulo) elemento.subtitle = subtitulo;
    if (imagem) elemento.image_url = imagem;
    if (url) {
      elemento.default_action = { type: 'web_url', url };
      elemento.buttons = [{ type: 'web_url', url, title: botao || 'Acessar' }];
    }
    return this.request('me/messages', {
      method: 'POST',
      body: {
        recipient,
        message: {
          attachment: {
            type: 'template',
            payload: { template_type: 'generic', elements: [elemento] },
          },
        },
      },
    });
  }

  async sendDirect(recipientId, text) {
    return this.request('me/messages', {
      method: 'POST',
      body: { recipient: { id: recipientId }, message: { text } },
    });
  }
}

/**
 * Renova o IG_ACCESS_TOKEN e grava de volta no .env.
 *
 * O token da via nova vale 60 dias, e não é permanente como o da via antiga.
 * A renovação estende por mais 60 a partir de hoje e pode ser feita quantas
 * vezes quiser, desde que o token ainda esteja válido. Se ele expirar, não há
 * renovação possível: é preciso gerar outro pelo painel.
 */
export async function renovarTokenIG({ silencioso = false } = {}) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const caminhoEnv = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

  const ig = new IGLoginClient();
  const r = await ig.request('refresh_access_token', { params: { grant_type: 'ig_refresh_token' } });
  if (!r.access_token) throw new Error('A renovação não devolveu token novo.');

  let env = readFileSync(caminhoEnv, 'utf8');
  env = env.replace(/^IG_ACCESS_TOKEN=.*$/m, `IG_ACCESS_TOKEN=${r.access_token}`);
  const hoje = new Date().toISOString().slice(0, 10);
  if (/^IG_TOKEN_RENOVADO_EM=/m.test(env)) {
    env = env.replace(/^IG_TOKEN_RENOVADO_EM=.*$/m, `IG_TOKEN_RENOVADO_EM=${hoje}`);
  } else {
    env += `\nIG_TOKEN_RENOVADO_EM=${hoje}\n`;
  }
  writeFileSync(caminhoEnv, env, 'utf8');

  const dias = Math.round(r.expires_in / 86400);
  if (!silencioso) console.log(`🔑 Token do Instagram renovado por mais ${dias} dias.`);
  return { dias };
}

/** Renova sozinho quando já passaram 30 dias, para nunca chegar perto do vencimento. */
export async function renovarSePreciso(env, { log = console.log } = {}) {
  // Na nuvem (GitHub Actions) não existe .env para gravar, e o token vem de um
  // Secret. Lá quem renova é o fluxo "Renovar token do Instagram".
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const caminhoEnv = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!existsSync(caminhoEnv)) return false;

  const ultima = env.IG_TOKEN_RENOVADO_EM;
  if (ultima) {
    const dias = (Date.now() - new Date(ultima).getTime()) / 86400000;
    if (dias < 30) return false;
  }
  try {
    await renovarTokenIG({ silencioso: true });
    log('🔑 Token do Instagram renovado automaticamente (+60 dias).');
    return true;
  } catch (err) {
    log(`⚠️  Não consegui renovar o token do Instagram: ${err.message}`);
    return false;
  }
}
