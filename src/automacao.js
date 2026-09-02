// Motor de automação estilo ManyChat para o Instagram.
//
// Como funciona: a cada ciclo o motor lê os comentários dos posts recentes e as
// mensagens novas do Direct, procura as palavras-chave das regras e executa a
// ação configurada (resposta pública no comentário + Direct com o link).
//
// Não usa webhook: faz polling. Isso evita depender de servidor público, mas
// significa que a automação só responde enquanto o processo estiver rodando.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { segueVoce } from './client-ig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const CAMINHO_REGRAS = join(RAIZ, 'automacao.json');
const CAMINHO_ESTADO = join(RAIZ, '.automacao-estado.json');

// ---------------------------------------------------------------- utilidades

/** Tira acentos, pontuação e caixa, para comparar o que a pessoa escreveu. */
export function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Casa a palavra-chave como palavra inteira, nunca como pedaço de outra.
 * Sem isso "quero" casaria dentro de "requerimento" e a automação dispararia
 * em cima de quem não pediu nada.
 */
export function casaPalavra(textoNormalizado, palavra) {
  const alvo = normalizar(palavra);
  if (!alvo) return false;
  const escapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escapado}(\\s|$)`).test(textoNormalizado);
}

/** Primeira regra ativa cujo gatilho aparece no texto. */
export function acharRegra(regras, texto, { mediaId = null, origem = 'comentario' } = {}) {
  const normalizado = normalizar(texto);
  if (!normalizado) return null;
  for (const regra of regras) {
    if (regra.ativo === false) continue;
    if (regra.origens && !regra.origens.includes(origem)) continue;
    if (Array.isArray(regra.midias) && mediaId && !regra.midias.includes(mediaId)) continue;
    if ((regra.palavras || []).some((p) => casaPalavra(normalizado, p))) return regra;
  }
  return null;
}

/** Varia a resposta pública para não repetir a mesma frase debaixo do post. */
function sortear(lista) {
  if (!lista || lista.length === 0) return null;
  return lista[Math.floor(Math.random() * lista.length)];
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ regras/estado

export function carregarRegras(caminho = CAMINHO_REGRAS) {
  if (!existsSync(caminho)) {
    throw new Error(
      `Arquivo de regras não encontrado: ${caminho}\n` +
        'Copie automacao.exemplo.json para automacao.json e edite as palavras-chave.'
    );
  }
  const config = JSON.parse(readFileSync(caminho, 'utf8'));
  if (!Array.isArray(config.regras) || config.regras.length === 0) {
    throw new Error('O arquivo de regras precisa ter pelo menos uma regra em "regras".');
  }
  return config;
}

export function carregarEstado(caminho = CAMINHO_ESTADO) {
  if (!existsSync(caminho)) return { comentarios: {}, conversas: {}, execucoes: 0 };
  try {
    const estado = JSON.parse(readFileSync(caminho, 'utf8'));
    return { comentarios: {}, conversas: {}, execucoes: 0, ...estado };
  } catch {
    return { comentarios: {}, conversas: {}, execucoes: 0 };
  }
}

/** Grava o arquivo de regras preservando a indentação usada no projeto. */
export function salvarRegras(config, caminho = CAMINHO_REGRAS) {
  writeFileSync(caminho, JSON.stringify(config, null, 2), 'utf8');
}

export function salvarEstado(estado, caminho = CAMINHO_ESTADO) {
  writeFileSync(caminho, JSON.stringify(estado, null, 2), 'utf8');
}

// ------------------------------------------------------------------- ciclo

/**
 * Roda um ciclo: lê comentários e Directs, aplica as regras e age.
 * Com `dryRun`, mostra o que faria sem chamar nenhum endpoint de escrita.
 */
export async function rodarCiclo(ig, config, estado, { dryRun = false, log = console.log } = {}) {
  const janelaMs = (config.janelaHoras ?? 48) * 60 * 60 * 1000;
  const limiteAcoes = config.maxAcoesPorCiclo ?? 20;
  const pausaMs = config.pausaEntreAcoesMs ?? 1500;
  const ignorar = (config.ignorarUsuarios || []).map((u) => u.toLowerCase().replace('@', ''));
  const agora = Date.now();
  const acoes = [];

  const recente = (timestamp) => {
    if (!timestamp) return true;
    const t = new Date(timestamp).getTime();
    return Number.isNaN(t) ? true : agora - t <= janelaMs;
  };

  // ---- 1. Comentários dos posts recentes
  const posts = await ig.listMedia(config.postsVerificados ?? 6);
  for (const post of posts) {
    // Não filtramos por idade do POST: gente comenta hoje em post de meses atrás.
    // Quem manda é a idade do COMENTÁRIO, checada logo abaixo.
    let comentarios = [];
    try {
      comentarios = await ig.listComments(post.id, 50);
    } catch (err) {
      log(`⚠️  Não consegui ler os comentários do post ${post.id}: ${err.message}`);
      continue;
    }

    for (const c of comentarios) {
      if (acoes.length >= limiteAcoes) break;
      if (estado.comentarios[c.id]) continue; // já respondido
      if (!recente(c.timestamp)) continue;
      const autor = (c.username || '').toLowerCase();
      if (ignorar.includes(autor)) continue;

      const regra = acharRegra(config.regras, c.text, { mediaId: post.id, origem: 'comentario' });
      if (!regra) continue;

      // Gate de seguidor: algumas iscas só são liberadas para quem já segue.
      // A consulta só responde para quem interagiu, que é o caso de quem comentou.
      if (regra.exigirSeguidor) {
        const segue = await segueVoce(ig, c.from?.id);
        if (segue === false) {
          const aviso = regra.avisoNaoSegue ||
            'Oi! Esse material eu envio para quem me acompanha por aqui. Me segue e comenta de novo que eu te mando na hora. 💜';
          const r = { tipo: 'comentario', regra: regra.nome, autor: c.username, texto: c.text, publica: null, direct: '[não segue] ' + aviso.split('\n')[0], em: new Date().toISOString(), erros: [] };
          if (!dryRun) {
            try {
              await ig.privateReplyToComment(c.id, aviso);
            } catch (err) {
              r.erros.push(`aviso: ${err.message}`);
            }
            estado.comentarios[c.id] = { regra: regra.nome, em: r.em, naoSegue: true, erros: r.erros };
            await espera(pausaMs);
          }
          acoes.push(dryRun ? { ...r, simulado: true } : r);
          continue;
        }
      }

      const publica = sortear(regra.respostaPublica || config.respostaPublicaPadrao);
      const direct = regra.direct;
      const envio = regra.cartao ? `[cartão] ${regra.cartao.titulo} → ${regra.cartao.botao || 'Acessar'}` : direct;
      const acao = { tipo: 'comentario', regra: regra.nome, autor: c.username, texto: c.text, publica, direct: envio };

      if (dryRun) {
        acoes.push({ ...acao, simulado: true });
        continue;
      }

      const resultado = { ...acao, em: new Date().toISOString(), erros: [] };
      // O Direct vai PRIMEIRO, de propósito. A resposta pública diz "te mandei
      // no direct", então ela só pode ser publicada depois que o direct saiu.
      // Isso também protege contra responder a um comentário da própria conta:
      // nesse caso o direct falha e a resposta pública nem chega a ser postada.
      let directOk = false;
      if (direct || regra.cartao) {
        try {
          if (regra.cartao) {
            await ig.sendCard({ comment_id: c.id }, regra.cartao);
          } else {
            await ig.privateReplyToComment(c.id, direct);
          }
          directOk = true;
        } catch (err) {
          resultado.erros.push(`direct: ${err.message}`);
        }
        await espera(pausaMs);
      }
      if (publica && (directOk || (!direct && !regra.cartao))) {
        try {
          await ig.replyToComment(c.id, publica);
        } catch (err) {
          resultado.erros.push(`resposta pública: ${err.message}`);
        }
        await espera(pausaMs);
      } else if (publica) {
        resultado.erros.push('resposta pública não postada: o direct falhou antes');
      }
      // Marca mesmo com erro: evita ficar batendo no mesmo comentário a cada ciclo.
      estado.comentarios[c.id] = { regra: regra.nome, em: resultado.em, erros: resultado.erros };
      acoes.push(resultado);
    }
  }

  // ---- 2. Mensagens novas do Direct
  if (config.responderDirect !== false) {
    let conversas = [];
    try {
      conversas = await ig.listConversations(config.conversasVerificadas ?? 20);
    } catch (err) {
      log(`⚠️  Não consegui ler o Direct: ${err.message}`);
    }

    for (const conversa of conversas) {
      if (acoes.length >= limiteAcoes) break;
      const ultima = conversa.messages?.data?.[0];
      if (!ultima) continue;
      // Só reage a mensagem recebida; ignora quando a última fala foi da Simone.
      if (ultima.from?.id && String(ultima.from.id) === String(ig.igUserId)) continue;
      if (!recente(ultima.created_time)) continue;
      const chave = ultima.id || conversa.id;
      if (estado.conversas[chave]) continue; // já respondido

      const regra = acharRegra(config.regras, ultima.message, { origem: 'direct' });
      if (!regra) continue;
      const texto = regra.direct || regra.respostaDirect;
      if (!texto && !regra.cartao) continue;

      const envioD = regra.cartao ? `[cartão] ${regra.cartao.titulo}` : texto;
      const acao = { tipo: 'direct', regra: regra.nome, de: ultima.from?.username || ultima.from?.id, texto: ultima.message, envio: envioD };
      if (dryRun) {
        acoes.push({ ...acao, simulado: true });
        continue;
      }

      const resultado = { ...acao, em: new Date().toISOString(), erros: [] };
      try {
        if (regra.cartao) await ig.sendCard({ id: ultima.from.id }, regra.cartao);
        else await ig.sendDirect(ultima.from.id, texto);
      } catch (err) {
        resultado.erros.push(err.message);
      }
      estado.conversas[chave] = { regra: regra.nome, em: resultado.em, erros: resultado.erros };
      acoes.push(resultado);
      await espera(pausaMs);
    }
  }

  estado.execucoes = (estado.execucoes || 0) + 1;
  estado.ultimaExecucao = new Date().toISOString();
  return acoes;
}

/** Formata um ciclo para o terminal. */
export function relatar(acoes, { dryRun = false, log = console.log } = {}) {
  if (acoes.length === 0) {
    log('— nada novo neste ciclo.');
    return;
  }
  for (const a of acoes) {
    const marca = dryRun ? '[simulação]' : a.erros?.length ? '❌' : '✅';
    if (a.tipo === 'comentario') {
      log(`${marca} comentário de @${a.autor} → regra "${a.regra}"`);
      log(`   disse: ${a.texto}`);
      if (a.publica) log(`   respondi no post: ${a.publica}`);
      if (a.direct) log(`   mandei no direct: ${a.direct.split('\n')[0]}`);
    } else {
      log(`${marca} direct de ${a.de} → regra "${a.regra}"`);
      log(`   disse: ${a.texto}`);
      log(`   respondi: ${a.envio.split('\n')[0]}`);
    }
    if (a.erros?.length) log(`   erros: ${a.erros.join(' | ')}`);
  }
}

export { CAMINHO_REGRAS, CAMINHO_ESTADO };
