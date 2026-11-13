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

1. Uma pessoa informa apelido e código da sala. A primeira pessoa cria a sala; as demais entram com o mesmo código.
2. Um servidor Node.js com WebSocket mantém a lista temporária de participantes e encaminha somente as mensagens de signaling necessárias para negociar WebRTC.
3. Cada participante cria uma conexão WebRTC com cada participante já conectado. O participante que acabou de entrar inicia a oferta para evitar que os dois lados iniciem a negociação ao mesmo tempo.
4. Cada par abre um DataChannel ordenado chamado `blackboard-v1`. Depois de conectado, as mensagens do quadro trafegam diretamente entre os navegadores.
5. A interface aplica cada ação ao estado local e a envia aos demais pares. Uma pessoa que entra depois solicita uma cópia do estado atual ao participante conectado há mais tempo.

### Decisões do MVP

- Limite de **4 participantes por sala**, adequado para a demonstração e para uma malha pequena.
- O quadro oferece desenho livre e post-its. Não haverá anexos, contas de usuário, histórico ou persistência.
- Traços recebem IDs únicos e mensagens de pontos sequenciadas. Post-its usam versão lógica; se duas pessoas alterarem o mesmo post-it, vence a versão maior (contador e, em empate, ID do participante).
- Exclusões são mantidas como tombstones durante a vida da sala para não fazer um item reaparecer ao receber um estado antigo.
- A entrada tardia usa um snapshot enviado pelo participante conectado há mais tempo. O cliente mescla o snapshot com mensagens que já recebeu, em vez de apagar seu estado local.
- O signaling mantém salas apenas em memória. Quando todos saem, a sala e o quadro desaparecem.
- O MVP configura STUN. TURN fica fora do escopo inicial e poderá ser necessário em algumas redes restritas.

O contrato detalhado de mensagens, campos, validação e fluxos está em [docs/PROTOCOL.md](docs/PROTOCOL.md). Ele deve ser a referência compartilhada entre as implementações de UI, estado/sincronização e signaling/WebRTC.

### Servidores e limites

- **Signaling:** necessário para iniciar a conexão; não precisa transportar cada ação após o canal P2P estar aberto.
- **STUN:** ajuda a estabelecer conexão direta através de NAT.
- **TURN:** retransmite dados quando a conexão direta não funciona; pode ser necessário em produção ou em redes restritas.
- **Persistência:** sem um nó persistente ou exportação, o quadro pode desaparecer quando todos os pares saírem.
- **Segurança:** validar mensagens e limitar tamanho/tipo de arquivos recebidos. Criptografia do transporte WebRTC não substitui controle de acesso e validação da aplicação.

Para este MVP, o cliente deve validar os limites de texto, pontos e dimensões descritos no protocolo. O código da sala é um identificador de encontro, não um mecanismo de autenticação.

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

