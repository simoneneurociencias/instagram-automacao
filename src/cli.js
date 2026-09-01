#!/usr/bin/env node
// CLI da integração com o Instagram.
// Uso: node src/cli.js <comando> [args...]

import { IGClient } from './client.js';
import { IGLoginClient, renovarTokenIG, renovarSePreciso } from './client-ig.js';
import { loadEnv } from './client.js';
import {
  carregarRegras,
  salvarRegras,
  carregarEstado,
  salvarEstado,
  rodarCiclo,
  relatar,
  acharRegra,
} from './automacao.js';

// Frases que imitam o que as pessoas escrevem de verdade nos comentarios.
const TEXTOS_DE_TESTE = [
  'EXPANSÃO',
  'expansao',
  'Expansão!!! quero muito',
  'quero o ebook',
  'que post lindo, obrigada',
  'meu requerimento foi negado',
];

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

const HELP = `
Instagram Manager — comandos disponíveis

  whoami                              Mostra dados da conta conectada
  token-debug                        Verifica validade/escopos do token
  exchange-token <shortToken>        Troca token curto por um de longa duração (~60 dias)
  list-media [--limit N]             Lista posts recentes

  publish-image --image <url> [--caption "texto"]
  publish-reel  --video <url> [--caption "texto"] [--cover <url>]
  publish-carousel --images "url1,url2,..." [--caption "texto"]

  comments <mediaId> [--limit N]     Lista comentários de um post
  reply-comment <commentId> --message "texto"
  hide-comment <commentId> [--unhide]

  dms [--limit N]                    Lista conversas recentes do Direct
  dm-messages <conversationId> [--limit N]
  send-dm <recipientId> --message "texto"   (só dentro da janela de 24h)

Automação (estilo ManyChat):
  automacao [--dry-run]              Roda uma passada: lê comentários/DMs e responde
  automacao --loop [--intervalo 60]  Fica rodando, checando a cada N segundos
  automacao-status                   Mostra quantos já foram atendidos
  posts [--limit N]                  Lista seus posts numerados, para escolher onde a regra vale
  regra-posts <regra> <1,3|todos>    Liga uma regra a posts específicos (ou a todos)
  painel [--porta 7788]              Abre o painel visual no navegador
  testar ["texto1" "texto2"]         Testa as suas regras sem token e sem tocar no Instagram
  ig-renovar-token                   Estende o token do Instagram por mais 60 dias

Exemplos:
  node src/cli.js whoami
  node src/cli.js publish-image --image https://.../foto.jpg --caption "Olá!"
`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }

  if (cmd === 'painel') {
    // Carregado só aqui: na nuvem o painel não existe, e um import no topo
    // derrubaria a automação inteira por causa de um arquivo que não vai para lá.
    const { iniciarPainel } = await import('./painel.js');
    iniciarPainel({ porta: Number(flags.porta) || 7788, abrir: !flags['sem-abrir'] });
    return; // o servidor segura o processo
  }

  // Bancada de teste: roda sem token, sem tocar no Instagram.
  if (cmd === 'testar') {
    const config = carregarRegras();
    const textos = positional.length > 0 ? positional : TEXTOS_DE_TESTE;
    console.log(`\nTestando ${textos.length} mensagem(ns) contra as suas regras.\n`);
    for (const texto of textos) {
      const regra = acharRegra(config.regras, texto, { origem: 'comentario' });
      if (!regra) {
        console.log(`⚪ "${texto}"\n   nenhuma regra casou — essa pessoa não receberia nada.\n`);
        continue;
      }
      const publica = (regra.respostaPublica || config.respostaPublicaPadrao || [])[0];
      console.log(`🟢 "${texto}"\n   regra: ${regra.nome}`);
      if (publica) console.log(`   responderia no post: ${publica}`);
      if (regra.direct) console.log(`   mandaria no direct:\n${regra.direct.split('\n').map((l) => '      ' + l).join('\n')}`);
      console.log('');
    }
    return;
  }

  // O cliente da via antiga só nasce quando algum comando o usa de fato.
  // Criá-lo aqui exigiria ACCESS_TOKEN sempre, e na nuvem só existe o token da
  // via nova (IG_ACCESS_TOKEN), o que derrubava a automação antes de começar.
  let clienteAntigo = null;
  const ig = new Proxy(
    {},
    {
      get(_alvo, prop) {
        if (!clienteAntigo) clienteAntigo = new IGClient();
        const valor = clienteAntigo[prop];
        return typeof valor === 'function' ? valor.bind(clienteAntigo) : valor;
      },
    }
  );

  switch (cmd) {
    case 'whoami':
      out(await ig.whoami());
      break;

    case 'token-debug':
      out(await ig.debugToken());
      break;

    case 'exchange-token': {
      const shortToken = positional[0];
      if (!shortToken) throw new Error('Uso: exchange-token <shortToken>');
      if (!ig.appId || !ig.appSecret) throw new Error('Preencha APP_ID e APP_SECRET no .env primeiro.');
      const result = await ig.exchangeLongLivedToken(shortToken);
      console.error('\n✅ Token de longa duração gerado. Cole o valor abaixo em ACCESS_TOKEN no .env:\n');
      out(result);
      break;
    }

    case 'list-media':
      out(await ig.listMedia(Number(flags.limit) || 10));
      break;

    case 'publish-image': {
      if (!flags.image) throw new Error('Use --image <url pública>');
      const container = await ig.createImageContainer({ imageUrl: flags.image, caption: flags.caption });
      const result = await ig.publishContainer(container.id);
      out({ container: container.id, published: result });
      break;
    }

    case 'publish-reel': {
      if (!flags.video) throw new Error('Use --video <url pública>');
      const container = await ig.createReelContainer({
        videoUrl: flags.video,
        caption: flags.caption,
        coverUrl: flags.cover,
      });
      console.error('Processando vídeo... aguarde.');
      await ig.waitForContainer(container.id);
      const result = await ig.publishContainer(container.id);
      out({ container: container.id, published: result });
      break;
    }

    case 'publish-carousel': {
      if (!flags.images) throw new Error('Use --images "url1,url2,..."');
      const urls = String(flags.images).split(',').map((s) => s.trim()).filter(Boolean);
      if (urls.length < 2) throw new Error('Carrossel precisa de pelo menos 2 itens.');
      const children = [];
      for (const url of urls) {
        const item = await ig.createCarouselItem({ imageUrl: url });
        children.push(item.id);
      }
      const container = await ig.createCarouselContainer({ children, caption: flags.caption });
      const result = await ig.publishContainer(container.id);
      out({ container: container.id, published: result });
      break;
    }

    case 'comments': {
      const mediaId = positional[0];
      if (!mediaId) throw new Error('Informe o mediaId: comments <mediaId>');
      out(await ig.listComments(mediaId, Number(flags.limit) || 50));
      break;
    }

    case 'reply-comment': {
      const commentId = positional[0];
      if (!commentId || !flags.message) throw new Error('Uso: reply-comment <commentId> --message "texto"');
      out(await ig.replyToComment(commentId, flags.message));
      break;
    }

    case 'hide-comment': {
      const commentId = positional[0];
      if (!commentId) throw new Error('Uso: hide-comment <commentId> [--unhide]');
      out(await ig.hideComment(commentId, !flags.unhide));
      break;
    }

    case 'dms':
      out(await ig.listConversations(Number(flags.limit) || 20));
      break;

    case 'dm-messages': {
      const convId = positional[0];
      if (!convId) throw new Error('Uso: dm-messages <conversationId>');
      out(await ig.listMessages(convId, Number(flags.limit) || 20));
      break;
    }

    case 'send-dm': {
      const recipientId = positional[0];
      if (!recipientId || !flags.message) throw new Error('Uso: send-dm <recipientId> --message "texto"');
      out(await ig.sendDirect(recipientId, flags.message));
      break;
    }

    case 'automacao': {
      // A automacao fala pela API com Login do Instagram: e a unica que permite
      // enviar Direct e que devolve o autor do comentario. Ver AUTOMACAO.md.
      await renovarSePreciso(loadEnv());
      const igAuto = new IGLoginClient();
      const config = carregarRegras();
      const estado = carregarEstado();
      const dryRun = Boolean(flags['dry-run'] || flags.dry);
      const intervalo = Number(flags.intervalo) || 60;

      const passada = async () => {
        const acoes = await rodarCiclo(igAuto, config, estado, { dryRun });
        console.log(`\n[${new Date().toLocaleTimeString('pt-BR')}]`);
        relatar(acoes, { dryRun });
        if (!dryRun) salvarEstado(estado);
      };

      if (!flags.loop) {
        if (dryRun) console.log('Modo simulação: nada será enviado.');
        await passada();
        break;
      }

      console.log(`Automação no ar. Checando a cada ${intervalo}s. Ctrl+C para parar.`);
      if (dryRun) console.log('Modo simulação: nada será enviado.');
      for (;;) {
        try {
          await passada();
        } catch (err) {
          console.error('⚠️  Erro no ciclo:', err.message);
        }
        await new Promise((r) => setTimeout(r, intervalo * 1000));
      }
    }

    case 'ig-renovar-token':
      out(await renovarTokenIG());
      break;

    case 'posts': {
      const igp = new IGLoginClient();
      const posts = await igp.listMedia(Number(flags.limit) || 15);
      console.log('\nSeus posts mais recentes. Use o número para ligar uma regra a ele.\n');
      posts.forEach((p, i) => {
        const legenda = String(p.caption || '(sem legenda)').replace(/\s+/g, ' ').slice(0, 58);
        const data = p.timestamp ? p.timestamp.slice(0, 10).split('-').reverse().join('/') : '?';
        console.log(`${String(i + 1).padStart(2)}. ${data} · ${p.media_type.toLowerCase().padEnd(13)} · ${p.comments_count ?? 0} coment.`);
        console.log(`    ${legenda}`);
        console.log(`    id ${p.id}`);
      });
      console.log('\nPara ligar uma regra a posts específicos:');
      console.log('  npm run ig -- regra-posts <nome-da-regra> 1,3');
      console.log('Para a regra voltar a valer em todos:');
      console.log('  npm run ig -- regra-posts <nome-da-regra> todos\n');
      break;
    }

    case 'regra-posts': {
      const nome = positional[0];
      const escolha = positional[1];
      if (!nome || !escolha) {
        throw new Error('Uso: regra-posts <nome-da-regra> <1,3 | todos>');
      }
      const config = carregarRegras();
      const regra = config.regras.find((r) => r.nome === nome);
      if (!regra) {
        throw new Error(`Regra "${nome}" não existe. As que existem: ${config.regras.map((r) => r.nome).join(', ')}`);
      }

      if (escolha.toLowerCase() === 'todos') {
        delete regra.midias;
        salvarRegras(config);
        console.log(`✅ A regra "${nome}" agora vale para TODOS os posts verificados.`);
        break;
      }

      const igp = new IGLoginClient();
      const posts = await igp.listMedia(Number(flags.limit) || 15);
      const numeros = escolha.split(',').map((n) => Number(n.trim()));
      const escolhidos = [];
      for (const n of numeros) {
        const p = posts[n - 1];
        if (!p) throw new Error(`Não existe post número ${n}. Rode "posts" para ver a lista.`);
        escolhidos.push(p);
      }
      regra.midias = escolhidos.map((p) => p.id);
      salvarRegras(config);
      console.log(`✅ A regra "${nome}" agora vale SÓ nestes ${escolhidos.length} post(s):`);
      for (const p of escolhidos) {
        const legenda = String(p.caption || '(sem legenda)').replace(/\s+/g, ' ').slice(0, 55);
        console.log(`   · ${p.timestamp?.slice(0, 10).split('-').reverse().join('/')} — ${legenda}`);
      }
      break;
    }

    case 'automacao-status': {
      const estado = carregarEstado();
      out({
        ultimaExecucao: estado.ultimaExecucao || null,
        ciclosRodados: estado.execucoes || 0,
        comentariosAtendidos: Object.keys(estado.comentarios || {}).length,
        conversasAtendidas: Object.keys(estado.conversas || {}).length,
      });
      break;
    }

    default:
      console.error(`Comando desconhecido: ${cmd}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n❌', err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  process.exitCode = 1;
});
