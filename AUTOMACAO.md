# Automação do Instagram (estilo ManyChat)

Alguém comenta a palavra-chave no seu post, você responde publicamente e a pessoa
recebe o link no Direct. É o que o ManyChat faz, rodando na sua máquina, sem
mensalidade e sem teto de contatos.

## Como ligar

**Pelo painel (recomendado):** clique no atalho **"Painel Instagram"** no Desktop.
Tudo que está descrito abaixo pode ser feito por lá, no navegador.

**Pelo terminal**, se preferir:

**1. Crie o arquivo de regras**

```powershell
cd apps\instagram-manager
copy automacao.exemplo.json automacao.json
```

Abra `automacao.json` e edite: as palavras-chave, o texto da resposta pública e o
texto do Direct. Os links são placeholders (`COLE_O_LINK_DO_EBOOK`) — troque
pelos reais.

**2. Experimente na bancada (sem token, sem tocar no Instagram)**

```powershell
npm run ig -- testar
```

Roda um punhado de frases de exemplo contra as suas regras e mostra 🟢 para quem
receberia o link (com o texto inteiro do direct) e ⚪ para quem não receberia nada.

Para testar as suas próprias frases:

```powershell
npm run ig -- testar "EXPANSÃO" "quanto custa?" "quero participar"
```

É aqui que você afina as palavras-chave e a copy. Nada sai do computador.

**3. Teste contra o Instagram de verdade, sem enviar nada**

```powershell
npm run ig -- automacao --dry-run
```

Isso lê os comentários e as mensagens de verdade, mostra no terminal quem seria
atendido e com qual texto, e **não envia nada**. Rode isso primeiro, sempre.

**4. Ligue de verdade**

```powershell
npm run ig -- automacao              # uma passada só
npm run ig -- automacao --loop       # fica no ar, checando a cada 60s
npm run ig -- automacao --loop --intervalo 30
```

Ctrl+C para parar. Enquanto a janela estiver fechada, a automação não responde
(ela não roda na nuvem).

**5. Ver o que já foi atendido**

```powershell
npm run ig -- automacao-status
```

## O painel

O jeito mais fácil de usar tudo isto: um atalho **"Painel Instagram"** no Desktop.
Clique nele e o painel abre no navegador.

Pelo terminal: `npm run painel`

O que dá para fazer lá:

- **Ver a conta ao vivo**: seguidores, quantos comentários já foram atendidos, quantos
  ciclos rodaram, quando foi o último.
- **Escolher onde cada regra responde**: a aba "Onde responder" mostra seus posts em
  cartões clicáveis. Marque os da campanha e salve. Sem nenhum marcado, a regra vale
  para todos os posts verificados.
- **Ligar e desligar regras** pelo interruptor, na aba "Regras".
- **Simular** (não envia nada) ou **Rodar agora** (envia), com o resultado aparecendo
  na faixa preta embaixo.
- **Ligar o automático**, que fica respondendo a cada 60 segundos enquanto o painel
  estiver aberto.
- **Histórico**: quem foi atendido, por qual regra, e se deu certo.

O painel roda em `localhost:7788`, só na sua máquina. Fechar a janela desliga tudo,
inclusive o automático.

## O arquivo de regras

| Campo | O que faz |
|---|---|
| `palavras` | Gatilhos. Casam como palavra inteira, sem acento e sem caixa: `EXPANSÃO`, `expansao` e `Expansão!` casam igual. `quero` **não** casa dentro de `requerimento`. |
| `respostaPublica` | Lista de frases; o motor sorteia uma, para não repetir a mesma coisa debaixo de todo comentário. |
| `direct` | O texto que vai no Direct. Use `\n` para quebrar linha. |
| `origens` | `["comentario"]` ou `["direct"]` se a regra só vale para um dos dois. Sem o campo, vale para os dois. |
| `midias` | Lista de IDs de post, se a regra só deve valer para um post específico. |
| `cartao` | Cartão com imagem e botão, no lugar do texto. Ver abaixo. |
| `ativo` | `false` desliga a regra sem apagar. |

### Cartão com botão

Em vez de mandar um link solto no texto, a regra pode mandar um cartão: imagem,
título, subtítulo e um botão que abre a URL. É o que converte melhor, porque dá
um alvo óbvio para o dedo.

```json
"cartao": {
  "titulo": "Os 3 Segredos do Terapeuta de Alto Valor",
  "subtitulo": "Webinário ao vivo · 17/10, das 9h às 12h30",
  "imagem": "https://simoneneurociencias.github.io/card-dm.jpg",
  "url": "https://simoneneurociencias.github.io/",
  "botao": "Garantir minha vaga"
}
```

Quando a regra tem `cartao`, o campo `direct` é ignorado: vai um ou outro, nunca
os dois.

Limites da Meta: título e subtítulo até 80 caracteres cada, no máximo 3 botões, e
a imagem precisa estar numa URL pública.

**A imagem tem de ser quadrada.** O Direct corta as laterais de imagem horizontal:
a capa da LP (1200x630) chegou com o começo de cada linha do título cortado
("gredos do", "uta de"). A imagem do cartão é gerada por
`apps/lp-terapeutas/gerar-card-dm.py` em 1080x1080, e de propósito **não repete o
título**, já que o cartão o mostra em texto logo abaixo. Se a data mudar, altere a
constante `TARJA` no script e rode `python gerar-card-dm.py`.

**A ordem das regras é a prioridade**: a primeira que casar é a que dispara.
Palavras específicas em cima, genéricas embaixo (ou fora).

Ajustes gerais: `postsVerificados` (quantos posts recentes olhar, hoje 12),
`janelaHoras` (ignora comentário mais velho que isso), `maxAcoesPorCiclo`
(freio de segurança), `ignorarUsuarios` (a sua própria conta já está lá),
`conversasVerificadas` (quantas conversas do Direct ler por ciclo).

`janelaHoras` vale para a idade do **comentário**, nunca a do post. Uma versão
anterior pulava posts com mais de 48h antes de ler os comentários, e com isso
ninguém que comentasse num Reels antigo era atendido. Corrigido em 31/08/2026.

## O que a Meta permite e o que não permite

- **Responder comentário publicamente**: sempre pode.
- **Mandar Direct para quem comentou** (resposta privada): pode, e é o único jeito
  de iniciar conversa fora da janela de 24h. Mas **uma vez só por comentário** — se
  a mesma pessoa comentar de novo em outro post, aí sim ela recebe de novo.
- **Responder Direct**: só dentro de 24h da última mensagem dela.
- **Mandar Direct para quem não falou com você**: proibido. Não faça, é banimento.

O motor respeita tudo isso. Ele nunca inicia conversa com quem não interagiu.

## Por qual API a automação fala

A Meta tem dois caminhos para a mesma conta, e a automação usa o **novo**:

| | Login do Facebook (antigo) | Login do Instagram (novo) |
|---|---|---|
| Endereço | graph.facebook.com | graph.instagram.com |
| Enviar Direct | bloqueado: `(#3) does not have the capability` | funciona |
| Autor do comentário | não vem | vem em `from` |
| Conversas por consulta | 2, e instável | 10, estável |

Medido em 31/08/2026. O `client.js` (caminho antigo) segue servindo os comandos de
publicação do CLI; a automação usa o `client-ig.js`.

O token dessa via fica em `IG_ACCESS_TOKEN` no `.env` e é gerado em: painel do app →
Casos de uso → Gerenciar mensagens e conteúdo no Instagram → **Configuração da API com
login do Instagram** → Adicionar conta → Gerar token.

## Cuidados

- O motor marca o comentário como atendido **mesmo quando o envio falha**, para não
  ficar batendo no mesmo comentário a cada ciclo. Se algo falhar, o erro aparece no
  terminal com `❌`. Nesse caso, responda essa pessoa na mão.
- O estado fica em `.automacao-estado.json`. Apagar esse arquivo faz o motor tratar
  todo mundo como novo e **responder de novo** quem já foi atendido.
- `automacao.json` e o estado estão no `.gitignore` — a copy fica só na sua máquina.

## Permissões e token

São dois tokens, um por via, os dois no `.env`:

- **`IG_ACCESS_TOKEN`** (via nova) é o que a automação usa. Autorizado no consentimento
  do próprio Instagram, com comentários, mensagens, conteúdos e insights ligados.
- **`ACCESS_TOKEN`** (via antiga) serve os comandos de publicação do CLI. Permanente,
  com `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages` e
  `pages_show_list`.

A `instagram_manage_comments` da via antiga só foi liberada depois de o app ser
publicado, ou seja, depois de sair do modo Desenvolvimento.

O `ACCESS_TOKEN` **não expira** (o app publicado gerou token permanente). O acesso aos
dados se renova enquanto a integração é usada. Confira o estado com:

```powershell
npm run ig -- token-debug
```

Se o `IG_ACCESS_TOKEN` parar de funcionar, gere outro no painel do app: Casos de uso →
Gerenciar mensagens e conteúdo no Instagram → Configuração da API com login do Instagram
→ Gerar token. Cole no `.env`.

Se precisar renovar o `ACCESS_TOKEN` da via antiga: o Graph API Explorer costuma travar em
"Updating...". O caminho que funciona é abrir o diálogo de OAuth direto no navegador, com os
escopos na URL e `redirect_uri=https://simoneneurociencias.github.io/` (a Meta não aceita
mais URLs do facebook.com como retorno). O token volta na barra de endereço depois de
`access_token=`, e aí é só passar para `exchange-token`.
