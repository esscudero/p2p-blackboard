# Contrato do MVP: salas, mensagens e estado do quadro

Este documento define o contrato comum para as três frentes de implementação: signaling/WebRTC, interface e estado/sincronização. Use estes nomes e campos na implementação. Se for necessário mudar o contrato, atualize este documento antes de cada frente adotar formatos diferentes.

## 1. Escopo e decisões

- Até **4 participantes por sala**.
- Uma sala é identificada por um código informado pelo usuário. A primeira pessoa que entra cria a sala; não há distinção de permissões entre criador e demais participantes.
- Apelidos têm de 1 a 24 caracteres após remover espaços no início e no fim.
- O servidor de signaling é Node.js + WebSocket. Ele guarda somente salas e participantes em memória e encaminha SDP/ICE; não recebe mensagens do quadro.
- Topologia WebRTC em malha completa: cada par conectado tem um `RTCPeerConnection` e um DataChannel ordenado.
- O DataChannel chama-se `blackboard-v1` e usa mensagens JSON UTF-8.
- Estado é local aos participantes conectados. Não há banco de dados, conta, histórico ou recuperação depois que todos saem.
- O MVP inclui desenho livre e post-its, sem upload de arquivos.
- Coordenadas de itens e pontos são normalizadas entre `0` e `1` em relação ao quadro, para funcionar em telas de tamanhos diferentes.

## 2. Convenções compartilhadas

Todos os nomes de campo são `camelCase`; coordenadas usam números; mensagens são objetos JSON. O servidor valida mensagens de sala e de signaling. Cada navegador valida as mensagens recebidas no DataChannel.

Identificadores:

- `peerId`: UUID gerado pelo servidor ao aceitar a entrada na sala.
- `messageId`: UUID criado pelo remetente para cada mensagem P2P.
- IDs de objetos: string única criada pelo cliente, recomendação `peerId:contadorLocal`, por exemplo `p-abc:17`.
- `roomCode`: 1 a 32 caracteres, normalizado com `trim()` e letras maiúsculas. O código não é segredo nem senha.

Regras de tamanho para o MVP:

- Tamanho máximo de uma mensagem WebSocket ou DataChannel: **256 KiB**.
- Post-it: texto de 1 a 500 caracteres.
- Por sala: até 100 post-its, 100 traços e 5.000 pontos no total.
- Um traço: no máximo 1.000 pontos.
- Uma mensagem `stroke.points`: 1 a 128 pontos.
- Snapshot serializado: no máximo 256 KiB.
- `color`: hexadecimal `#RRGGBB`.
- `width`: 1 a 24 pixels CSS.

## 3. Protocolo de signaling (WebSocket)

O WebSocket é usado somente para descobrir participantes e encaminhar a negociação inicial. Toda mensagem de signaling tem JSON. Mensagens encaminhadas pelo servidor incluem `fromPeerId`; o remetente não escolhe esse campo.

### 3.1 Cliente → servidor

```ts
type ClientSignalMessage =
  | { type: 'room.join'; roomCode: string; nickname: string }
  | { type: 'room.leave' }
  | { type: 'signal.offer'; toPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.answer'; toPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.ice'; toPeerId: string; candidate: RTCIceCandidateInit };
```

`room.join` é a primeira mensagem da conexão. O servidor rejeita código ou apelido inválidos e salas com 4 participantes. Apenas participantes da mesma sala podem encaminhar mensagens uns aos outros.

### 3.2 Servidor → cliente

```ts
type PeerInfo = { peerId: string; nickname: string };

type ServerSignalMessage =
  | {
      type: 'room.joined';
      roomCode: string;
      self: PeerInfo;
      peers: PeerInfo[];
      snapshotProviderId: string | null;
    }
  | { type: 'peer.joined'; peer: PeerInfo }
  | { type: 'peer.left'; peerId: string }
  | { type: 'signal.offer'; fromPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.answer'; fromPeerId: string; description: RTCSessionDescriptionInit }
  | { type: 'signal.ice'; fromPeerId: string; candidate: RTCIceCandidateInit }
  | { type: 'room.error'; code: RoomErrorCode; message: string };

type RoomErrorCode =
  | 'INVALID_ROOM_CODE'
  | 'INVALID_NICKNAME'
  | 'ROOM_FULL'
  | 'NOT_IN_ROOM'
  | 'PEER_NOT_FOUND'
  | 'INVALID_MESSAGE';
```

`peers` em `room.joined` contém quem já estava na sala, em ordem de entrada. `snapshotProviderId` é o `peerId` do participante conectado há mais tempo, ou `null` se a sala acabou de ser criada. Quando um participante entra, os participantes existentes também recebem `peer.joined`.

### 3.3 Fluxo de conexão

1. Cliente abre WebSocket e envia `room.join`.
2. O servidor responde `room.joined`; o participante que entra cria uma conexão para cada item de `peers`.
3. O participante novo cria e envia `signal.offer` para cada par existente. O participante existente aplica a oferta, cria uma resposta e envia `signal.answer`.
4. Ambos encaminham candidatos ICE com `signal.ice`.
5. O participante novo cria o DataChannel `blackboard-v1` antes de criar a oferta. O outro lado recebe o DataChannel pelo evento `datachannel`.
6. Ao fechar a aba ou sair, o cliente envia `room.leave` quando possível e fecha as conexões. O servidor também remove o participante se o WebSocket fechar e avisa os demais com `peer.left`.

Só o participante que acabou de entrar inicia a oferta para cada participante existente. Isso evita negociação duplicada para o mesmo par no fluxo normal.

## 4. Protocolo P2P (DataChannel)

Toda mensagem P2P tem um envelope comum:

```ts
type PeerEnvelope<TType extends string, TPayload> = {
  protocol: 1;
  messageId: string;
  senderId: string;
  type: TType;
  payload: TPayload;
};
```

`senderId` deve ser igual ao `peerId` associado à conexão WebRTC. Mensagens desconhecidas, versão diferente ou payload inválido são ignorados e registrados para diagnóstico; não derrubam a sala.

### 4.1 Tipos e mensagens

```ts
type Point = { x: number; y: number }; // cada coordenada entre 0 e 1

type Version = {
  counter: number; // inteiro crescente no cliente que faz a alteração
  peerId: string;  // desempate determinístico
};

type Stroke = {
  id: string;
  createdBy: string;
  color: string;       // #RRGGBB
  width: number;       // 1..24 px CSS
  points: Point[];
  lastSeq: number;     // último índice de ponto incluído; começa em 0
  finished: boolean;
};

type StickyNote = {
  id: string;
  text: string;        // 1..500 caracteres
  color: 'yellow' | 'blue' | 'pink' | 'green';
  x: number;           // posição normalizada, 0..1
  y: number;           // posição normalizada, 0..1
  version: Version;
};

type BoardState = {
  strokes: Record<string, Stroke>;
  stickies: Record<string, StickyNote>;
  deleted: Record<string, Version>; // tombstones por ID de objeto
};

type PeerMessage =
  | PeerEnvelope<'stroke.start', {
      strokeId: string; color: string; width: number; firstPoint: Point;
    }>
  | PeerEnvelope<'stroke.points', {
      strokeId: string; fromSeq: number; points: Point[];
    }>
  | PeerEnvelope<'stroke.end', { strokeId: string; finalSeq: number }>
  | PeerEnvelope<'sticky.upsert', { sticky: StickyNote }>
  | PeerEnvelope<'object.delete', { objectId: string; version: Version }>
  | PeerEnvelope<'board.snapshot.request', { requestId: string }>
  | PeerEnvelope<'board.snapshot', {
      requestId: string; state: BoardState;
    }>;
```

O ID do traço é escolhido no cliente antes de enviar `stroke.start`. O primeiro ponto tem sequência `0`. Cada `stroke.points` começa em `fromSeq` e traz pontos consecutivos. Uma mensagem duplicada é inofensiva: o receptor só acrescenta pontos que ainda não possui. `stroke.end.finalSeq` informa o último índice esperado e marca o traço como concluído.

Para reduzir tráfego, a interface pode agrupar pontos por quadro de animação ou enviar lotes pequenos. Não espere pelo fim do traço para replicá-lo; os outros participantes devem vê-lo enquanto é desenhado.

## 5. Regras de aplicação e conflitos

### Traços

- Traços são imutáveis quanto a cor e largura depois de `stroke.start` e pertencem a quem os criou.
- Eventos de pontos e fim são aceitos somente para o traço correspondente; pontos recebidos são anexados por sequência e nunca duplicados.
- Traços têm IDs únicos, portanto dois participantes desenhando ao mesmo tempo não conflitam.
- Excluir um traço usa `object.delete`, como para qualquer outro objeto.

### Post-its e exclusões

- Cada criação, edição ou movimento do post-it envia o objeto completo em `sticky.upsert` com uma nova `version`.
- O contador local de versão aumenta em toda edição local. Ao receber uma versão remota, o contador local avança para pelo menos `max(contadorLocal, contadorRemoto)`, e a próxima edição local usa `+1`.
- Versões são ordenadas primeiro por `counter` e depois por `peerId` em ordem lexicográfica. A maior versão vence.
- `object.delete` grava uma tombstone. O item só é removido se a versão da exclusão for maior que a versão atual do post-it. Uma upsert antiga não pode recriar um ID com tombstone mais recente.
- Traços não são editados depois de criados e seus IDs nunca são reutilizados. Para traços, qualquer tombstone existente para o ID impede que uma cópia antiga do traço no snapshot o recrie.
- Não há desfazer nem restauração no MVP; para recriar um item excluído, use um novo ID.

### Snapshot e entrada tardia

1. Depois que o DataChannel com `snapshotProviderId` abre, o participante novo envia `board.snapshot.request` com um `requestId` único.
2. O participante indicado responde com `board.snapshot` contendo cópias de `strokes`, `stickies` e `deleted` naquele momento.
3. O participante novo **mescla** o snapshot ao seu estado. Não apaga ações que chegaram durante a conexão ou durante o envio do snapshot.
4. Traços são mesclados por ID e sequência: manter os pontos de cada sequência uma vez; `finished` é verdadeiro se qualquer cópia válida já estiver finalizada.
5. Post-its são mesclados usando a regra de versão; tombstones também são mesclados pela maior versão.
6. Se o provedor de snapshot sair antes de responder, solicitar ao participante conectado há mais tempo entre os restantes. Se não houver outros pares, o quadro começa vazio.

Cada ação local é aplicada imediatamente e enviada diretamente a todos os outros pares conectados. Mensagens recebidas não são retransmitidas. O transporte ordenado reduz reordenação no fluxo normal; IDs, sequências, versões e mesclagem tornam duplicatas e snapshots concorrentes seguros.

## 6. Configuração e limites conhecidos

- Frontend: `VITE_SIGNALING_URL`, por exemplo `ws://localhost:3001` em desenvolvimento.
- Servidor: variável `PORT`, com padrão `3001`.
- Configurar `RTCPeerConnection` com o servidor STUN público `stun:stun.l.google.com:19302`. TURN não faz parte do MVP.
- Ao atingir qualquer limite de objetos/pontos ou o limite de 256 KiB, a ação que excederia o limite deve ser recusada localmente com uma mensagem simples na interface. Isso mantém snapshots dentro do tamanho aceito.
- O servidor não guarda estado do quadro. Se todos os clientes desconectarem, a sala é removida.
- Não há autenticação: qualquer pessoa que conheça o código pode tentar entrar enquanto houver vaga.
- A malha é apropriada para a sala limitada a quatro pessoas, não para grupos grandes.

## 7. Divisão de implementação

**Pessoa 1 — signaling/WebRTC:** implementar as mensagens da seção 3, gestão temporária de sala, limite de participantes e criação/fechamento das conexões e DataChannels. O servidor não implementa a seção 4.

**Pessoa 2 — interface:** implementar entrada, apelido, código, canvas, desenho e post-its. A UI deve chamar funções locais de domínio e renderizar `BoardState`; não deve conhecer o WebSocket de signaling.

**Pessoa 3 — domínio/sincronização:** implementar os tipos e regras das seções 4 e 5 em um módulo sem dependência de React. Expor uma API simples para a UI (ações locais/estado) e uma função para receber `PeerMessage` do transporte.

Ponto de integração: a Pessoa 1 entrega ao módulo de sincronização uma função `sendToPeers(message)`. A Pessoa 3 entrega à UI estado e ações locais. Assim, os três módulos podem ser desenvolvidos em paralelo após concordarem com este contrato.
