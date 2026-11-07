# Blackboard P2P

Quadro colaborativo em tempo real para desenhar, organizar ideias e compartilhar conteúdo

## Por que explorar P2P neste projeto?

Um quadro é uma boa demonstração de comunicação P2P porque várias pessoas produzem e recebem pequenas mudanças visíveis — traços, movimentos e notas — enquanto colaboram. Com WebRTC DataChannels, os dados do quadro podem trafegar diretamente entre navegadores depois que a conexão é estabelecida. Isso permite demonstrar descoberta/entrada na sala, negociação de conexão, troca de mensagens, presença e recuperação de conexões usando um caso visual fácil de acompanhar.

P2P é uma escolha didática e adequada para salas pequenas, mas não é automaticamente a melhor arquitetura para qualquer escala. Em uma malha completa, cada participante mantém uma conexão com cada outro participante; o número de conexões cresce aproximadamente com `n × (n - 1) / 2`. Isso aumenta tráfego e trabalho no navegador conforme a sala cresce. O grupo deve definir um limite de participantes ou avaliar uma topologia diferente se escala for requisito.

WebRTC também não elimina toda infraestrutura de servidor. Um canal de **signaling** é necessário para os participantes trocarem SDP e candidatos ICE antes de se conectarem. STUN ajuda a descobrir caminhos de rede; algumas redes exigem TURN, que retransmite tráfego e pode ter custo. A aplicação precisa lidar com conexões que falham, entradas tardias e sincronização de estado.

## O que esperamos construir

- Entrada em uma sala por código, com nome ou apelido.
- Quadro com desenho livre e post-its
- Atualização das ações para os demais participantes em tempo real.
- Quadro temporário: ele existe enquanto houver participantes conectados; não haverá persistência após todos saírem.

## Tecnologias iniciais

- TypeScript e React para a interface.
- Vite para desenvolvimento local e build.
- WebRTC DataChannels para dados P2P. **Ainda não implementado.**

## Requisitos

- Node.js 20.19+ ou 22.12+ (requisito do Vite 8).
- npm (incluído no Node.js).

## Começar

```bash
npm install
npm run dev
```

Abra o endereço local exibido pelo Vite. Para gerar a versão de produção:

```bash
npm run build
npm run preview
```

## Arquitetura prevista

1. Uma pessoa cria uma sala e compartilha o código.
2. Participantes usam o signaling para anunciar a sala e negociar conexões WebRTC.
3. Depois da negociação, cada par abre um DataChannel.
4. A interface transforma gestos em mensagens de domínio, como `stroke.started`, `stroke.points`, `sticky.created` e `object.deleted`.
5. Os pares aplicam as mensagens ao estado local e atualizam o quadro. O conteúdo permanece enquanto houver participantes na sala.

O ingresso será por nome e código da sala; a troca de signaling, a topologia e as regras para participantes que entram depois ainda precisam ser decididas. Também falta definir como o sistema resolve edições simultâneas. Se escolherem CRDT, bibliotecas como Yjs podem ajudar, mas a integração com o transporte WebRTC e o signaling ainda precisa ser especificada. Como o quadro é efêmero, não haverá recuperação após todos saírem.

### Servidores e limites

- **Signaling:** necessário para iniciar a conexão; não precisa transportar cada ação após o canal P2P estar aberto.
- **STUN:** ajuda a estabelecer conexão direta através de NAT.
- **TURN:** retransmite dados quando a conexão direta não funciona; pode ser necessário em produção ou em redes restritas.
- **Persistência:** sem um nó persistente ou exportação, o quadro pode desaparecer quando todos os pares saírem.
- **Segurança:** validar mensagens e limitar tamanho/tipo de arquivos recebidos. Criptografia do transporte WebRTC não substitui controle de acesso e validação da aplicação.

## Estrutura

```text
.
├── src/                 # Interface React e estilos
├── index.html           # Documento inicial
├── vite.config.ts       # Configuração do Vite
├── tsconfig*.json       # Configuração TypeScript
├── .env.example         # Exemplo de configuração local
└── README.md
```

## Scripts

| Comando | Descrição |
| --- | --- |
| `npm run dev` | Inicia o servidor de desenvolvimento Vite |
| `npm run build` | Verifica tipos e gera o build de produção |
| `npm run preview` | Serve localmente o build gerado |

