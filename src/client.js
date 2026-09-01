// Cliente fino para a Instagram Graph API.
// Sem dependências externas: usa fetch nativo do Node (>=18).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Carrega variáveis do arquivo .env (parser mínimo, sem dependência). */
export function loadEnv() {
  const envPath = join(__dirname, '..', '.env');
  const env = { ...process.env };
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (value !== '') env[key] = value;
    }
  } catch {
    // .env ausente — segue só com process.env
  }
  return env;
}

export class IGClient {
  constructor(env = loadEnv()) {
    this.token = env.ACCESS_TOKEN;
    this.igUserId = env.IG_USER_ID;
    this.pageId = env.FB_PAGE_ID;
    this.appId = env.APP_ID;
    this.appSecret = env.APP_SECRET;
    this.version = env.GRAPH_VERSION || 'v23.0';
    this.base = `https://graph.facebook.com/${this.version}`;
    if (!this.token) {
      throw new Error('ACCESS_TOKEN ausente. Preencha o arquivo .env (veja .env.example).');
    }
  }

  /**
   * O Direct exige token da Página, não o do usuário. Buscamos uma vez e guardamos.
   */
  async pageAccessToken() {
    if (this._pageToken) return this._pageToken;
    const r = await this.request('me/accounts', { params: { fields: 'id,access_token' } });
    const page = (r.data || []).find((p) => !this.pageId || String(p.id) === String(this.pageId)) || r.data?.[0];
    if (!page?.access_token) throw new Error('Não consegui obter o token da Página (permissão pages_show_list).');
    this._pageToken = page.access_token;
    return this._pageToken;
  }

  /**
   * Repete a chamada quando a Graph API responde com erro passageiro.
   * A caixa de entrada da conta é grande e a API às vezes devolve
   * "Timeout" ou "reduce the amount of data" em consulta que funciona na segunda.
   */
  async requestComRetry(path, opts = {}, { tentativas = 3, esperaMs = 2000 } = {}) {
    let ultimo;
    for (let i = 0; i < tentativas; i++) {
      try {
        return await this.request(path, opts);
      } catch (err) {
        const passageiro = /Timeout|unknown error|reduce the amount of data/i.test(err.message);
        if (!passageiro) throw err;
        ultimo = err;
        if (i < tentativas - 1) await new Promise((r) => setTimeout(r, esperaMs));
      }
    }
    throw ultimo;
  }

  async request(path, { method = 'GET', params = {}, body = null, token = null } = {}) {
    const url = new URL(`${this.base}/${path}`);
    url.searchParams.set('access_token', token || this.token);
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
    if (!res.ok) {
      const msg = data?.error?.message || text || `HTTP ${res.status}`;
      const err = new Error(`Graph API erro: ${msg}`);
      err.details = data;
      throw err;
    }
    return data;
  }

  // ---- Diagnóstico ----
  async whoami() {
    if (this.igUserId) {
      return this.request(this.igUserId, {
        params: { fields: 'id,username,name,followers_count,media_count,profile_picture_url' },
      });
    }
    // Descobre o IG user id a partir da página.
    if (!this.pageId) throw new Error('Defina FB_PAGE_ID ou IG_USER_ID no .env.');
    const page = await this.request(this.pageId, {
      params: { fields: 'instagram_business_account{id,username,name,followers_count,media_count}' },
    });
    return page.instagram_business_account || page;
  }

  // ---- Publicação ----
  // image_url / video_url precisam ser URLs PÚBLICAS (a Meta busca o arquivo de lá).
  async createImageContainer({ imageUrl, caption }) {
    return this.request(`${this.igUserId}/media`, {
      method: 'POST',
      params: { image_url: imageUrl, caption },
    });
  }

  async createReelContainer({ videoUrl, caption, coverUrl }) {
    return this.request(`${this.igUserId}/media`, {
      method: 'POST',
      params: { media_type: 'REELS', video_url: videoUrl, caption, cover_url: coverUrl },
    });
  }

  async createCarouselItem({ imageUrl, videoUrl }) {
    const params = { is_carousel_item: true };
    if (videoUrl) {
      params.media_type = 'VIDEO';
      params.video_url = videoUrl;
    } else {
      params.image_url = imageUrl;
    }
    return this.request(`${this.igUserId}/media`, { method: 'POST', params });
  }

  async createCarouselContainer({ children, caption }) {
    return this.request(`${this.igUserId}/media`, {
      method: 'POST',
      params: { media_type: 'CAROUSEL', children: children.join(','), caption },
    });
  }

  async publishContainer(creationId) {
    return this.request(`${this.igUserId}/media_publish`, {
      method: 'POST',
      params: { creation_id: creationId },
    });
  }

  async containerStatus(creationId) {
    return this.request(creationId, { params: { fields: 'status_code,status' } });
  }

  /** Espera o container ficar FINISHED (necessário para vídeo/reels). */
  async waitForContainer(creationId, { timeoutMs = 120000, intervalMs = 4000 } = {}) {
    const start = Date.now();
    for (;;) {
      const { status_code } = await this.containerStatus(creationId);
      if (status_code === 'FINISHED') return;
      if (status_code === 'ERROR') throw new Error(`Container ${creationId} falhou no processamento.`);
      if (Date.now() - start > timeoutMs) throw new Error(`Timeout esperando container ${creationId}.`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async listMedia(limit = 10) {
    const data = await this.request(`${this.igUserId}/media`, {
      params: { fields: 'id,caption,media_type,permalink,timestamp,comments_count,like_count', limit },
    });
    return data.data || [];
  }

  // ---- Comentários ----
  async listComments(mediaId, limit = 50) {
    const data = await this.request(`${mediaId}/comments`, {
      params: { fields: 'id,text,username,timestamp,like_count,replies{id,text,username}', limit },
    });
    return data.data || [];
  }

  async replyToComment(commentId, message) {
    return this.request(`${commentId}/replies`, { method: 'POST', params: { message } });
  }

  async hideComment(commentId, hide = true) {
    return this.request(commentId, { method: 'POST', params: { hide } });
  }

  // ---- Directs (DMs) ----
  // Limitação da API: só é possível responder dentro de 24h após a última mensagem do usuário.
  // Lotes pequenos de propósito: a caixa de entrada é grande e a Graph API
  // recusa a consulta ("reduce the amount of data") quando se pede demais.
  async listConversations(limit = 5) {
    const token = await this.pageAccessToken();
    // Teto medido nesta conta: 2 conversas por consulta, e a paginação é
    // recusada. Mesmo o lote de 2 falha em cerca de metade das tentativas, então
    // recuamos para 1 quando ele não passa. Vêm as mais recentes primeiro.
    const TETO = 2;
    let data = null;
    for (const tamanho of [Math.min(limit, TETO), 1]) {
      try {
        data = await this.requestComRetry(`${this.pageId || this.igUserId}/conversations`, {
          token,
          params: { platform: 'instagram', fields: 'id,updated_time', limit: tamanho },
        });
        break;
      } catch (err) {
        if (tamanho === 1) throw err;
      }
    }
    const conversas = data?.data || [];
    // A última mensagem vem numa segunda chamada, uma conversa por vez: pedir
    // tudo junto estoura o limite de dados da Graph API nesta conta.
    for (const conversa of conversas) {
      try {
        const msgs = await this.listMessages(conversa.id, 1);
        conversa.messages = { data: msgs };
      } catch {
        conversa.messages = { data: [] };
      }
    }
    return conversas;
  }

  async listMessages(conversationId, limit = 20) {
    const token = await this.pageAccessToken();
    const data = await this.requestComRetry(conversationId, {
      token,
      params: { fields: `messages.limit(${limit}){message,from,to,created_time}` },
    });
    return data.messages?.data || [];
  }

  /**
   * Resposta privada a um comentário: manda um Direct para quem comentou.
   * É o único jeito permitido de iniciar uma conversa fora da janela de 24h,
   * e a Meta só aceita UMA resposta privada por comentário.
   */
  async privateReplyToComment(commentId, text) {
    const token = await this.pageAccessToken();
    return this.request(`${this.igUserId}/messages`, {
      method: 'POST',
      token,
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
  }

  async sendDirect(recipientId, text) {
    const token = await this.pageAccessToken();
    return this.request(`${this.igUserId}/messages`, {
      method: 'POST',
      token,
      body: { recipient: { id: recipientId }, message: { text } },
    });
  }

  // ---- Token ----
  async exchangeLongLivedToken(shortToken) {
    return this.request('oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: shortToken,
      },
    });
  }

  async debugToken() {
    return this.request('debug_token', {
      params: { input_token: this.token },
    });
  }
}
