import type {
  ClientSignalMessage,
  PeerInfo,
  RoomErrorCode,
  ServerSignalMessage,
} from './signalingTypes';

export type PeerEnvelopeLike = {
  protocol: number;
  messageId: string;
  senderId: string;
  type: string;
  payload: unknown;
};

export type PeerConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type PeerRoomOptions<TMessage extends PeerEnvelopeLike> = {
  signalingUrl: string;
  roomCode: string;
  nickname: string;
  isPeerMessage: (value: unknown) => value is TMessage;
  onMessage: (message: TMessage, peer: PeerInfo) => void;
  onPeersChange?: (peers: PeerInfo[]) => void;
  onPeerConnectionState?: (peer: PeerInfo, state: PeerConnectionState) => void;
  onDataChannelOpen?: (peer: PeerInfo) => void;
  onError?: (message: string, code?: RoomErrorCode) => void;
};

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];
const DATA_CHANNEL_LABEL = 'blackboard-v1';
const MAX_MESSAGE_BYTES = 256 * 1024;

export class PeerRoom<TMessage extends PeerEnvelopeLike> {
  private socket: WebSocket | null = null;
  private self: PeerInfo | null = null;
  private peers = new Map<string, PeerInfo>();
  private connections = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly options: PeerRoomOptions<TMessage>;
  private joined = false;

  public roomCode: string | null = null;
  public snapshotProviderId: string | null = null;

  constructor(options: PeerRoomOptions<TMessage>) {
    this.options = options;
  }

  get peerId(): string | null {
    return this.self?.peerId ?? null;
  }

  get participant(): PeerInfo | null {
    return this.self;
  }

  get otherParticipants(): PeerInfo[] {
    return [...this.peers.values()];
  }

  get openDataChannels(): PeerInfo[] {
    return this.otherParticipants.filter((peer) =>
      this.channels.get(peer.peerId)?.readyState === 'open',
    );
  }

  async connect(): Promise<void> {
    if (this.socket) throw new Error('Esta instância já iniciou uma conexão.');
    const socket = new WebSocket(this.options.signalingUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      socket.addEventListener('open', () => {
        this.sendSignal({
          type: 'room.join',
          roomCode: this.options.roomCode,
          nickname: this.options.nickname,
        });
      }, { once: true });

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        void this.handleSignal(event.data, () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, rejectOnce);
      });

      socket.addEventListener('error', () => {
        rejectOnce(new Error('Não foi possível conectar ao servidor de signaling.'));
      }, { once: true });

      socket.addEventListener('close', () => {
        if (!settled) rejectOnce(new Error('A conexão com o servidor foi encerrada.'));
        this.cleanupConnections();
        this.joined = false;
      });
    });
  }

  sendToPeers(message: TMessage): number {
    if (!this.self) return 0;
    if (message.senderId !== this.self.peerId) {
      throw new Error('senderId da mensagem deve corresponder ao peerId local.');
    }

    const encoded = JSON.stringify(message);
    if (new TextEncoder().encode(encoded).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error('A mensagem P2P excede o limite de 256 KiB.');
    }

    let sent = 0;
    for (const channel of this.channels.values()) {
      if (channel.readyState !== 'open') continue;
      channel.send(encoded);
      sent += 1;
    }
    return sent;
  }

  sendToPeer(peerId: string, message: TMessage): boolean {
    if (!this.self) return false;
    if (message.senderId !== this.self.peerId) {
      throw new Error('senderId da mensagem deve corresponder ao peerId local.');
    }

    const peer = this.peers.get(peerId);
    if (!peer) return false;
    const channel = this.channels.get(peerId);
    if (channel?.readyState !== 'open') return false;

    const encoded = JSON.stringify(message);
    if (new TextEncoder().encode(encoded).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error('A mensagem P2P excede o limite de 256 KiB.');
    }

    channel.send(encoded);
    return true;
  }

  broadcast(message: TMessage): number {
    return this.sendToPeers(message);
  }

  disconnect(): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.joined) {
      this.sendSignal({ type: 'room.leave' });
    }
    this.socket?.close(1000, 'Participant left the room');
    this.socket = null;
    this.joined = false;
    this.cleanupConnections();
  }

  private sendSignal(message: ClientSignalMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private async handleSignal(
    raw: unknown,
    onJoined: () => void,
    rejectJoin: (error: Error) => void,
  ): Promise<void> {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      this.options.onError?.('Mensagem de signaling inválida ou muito grande.');
      return;
    }

    let message: ServerSignalMessage;
    try {
      message = JSON.parse(raw) as ServerSignalMessage;
    } catch {
      this.options.onError?.('O servidor enviou uma mensagem inválida.');
      return;
    }

    switch (message.type) {
      case 'room.joined': {
        this.joined = true;
        this.roomCode = message.roomCode;
        this.self = message.self;
        this.snapshotProviderId = message.snapshotProviderId;
        this.peers = new Map(message.peers.map((peer) => [peer.peerId, peer]));
        this.emitPeersChange();
        onJoined();
        await Promise.all(message.peers.map((peer) => this.createPeerConnection(peer, true)));
        break;
      }
      case 'peer.joined':
        this.peers.set(message.peer.peerId, message.peer);
        this.emitPeersChange();
        break;
      case 'peer.left': {
        this.peers.delete(message.peerId);
        this.connections.get(message.peerId)?.close();
        this.connections.delete(message.peerId);
        this.channels.delete(message.peerId);
        this.pendingCandidates.delete(message.peerId);
        if (this.snapshotProviderId === message.peerId) {
          this.snapshotProviderId = this.otherParticipants[0]?.peerId ?? null;
        }
        this.emitPeersChange();
        break;
      }
      case 'signal.offer':
        await this.handleOffer(message.fromPeerId, message.description);
        break;
      case 'signal.answer':
        await this.handleAnswer(message.fromPeerId, message.description);
        break;
      case 'signal.ice':
        await this.handleIceCandidate(message.fromPeerId, message.candidate);
        break;
      case 'room.error':
        this.options.onError?.(message.message, message.code);
        if (!this.joined) {
          rejectJoin(new Error(message.message));
          this.socket?.close(1008, 'Room join rejected');
        }
        break;
    }
  }

  private async createPeerConnection(peer: PeerInfo, isInitiator: boolean): Promise<void> {
    if (this.connections.has(peer.peerId)) return;

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.connections.set(peer.peerId, connection);
    this.pendingCandidates.set(peer.peerId, []);
    this.options.onPeerConnectionState?.(peer, 'connecting');

    connection.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.sendSignal({
        type: 'signal.ice',
        toPeerId: peer.peerId,
        candidate: candidate.toJSON(),
      });
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === 'new' || state === 'connecting' || state === 'connected'
        || state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.options.onPeerConnectionState?.(peer, state);
      }
    };

    connection.ondatachannel = (event) => this.attachDataChannel(peer, event.channel);

    if (isInitiator) {
      const channel = connection.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      this.attachDataChannel(peer, channel);
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (connection.localDescription) {
        this.sendSignal({
          type: 'signal.offer',
          toPeerId: peer.peerId,
          description: connection.localDescription,
        });
      }
    }
  }

  private attachDataChannel(peer: PeerInfo, channel: RTCDataChannel): void {
    if (channel.label !== DATA_CHANNEL_LABEL) {
      channel.close();
      return;
    }
    this.channels.set(peer.peerId, channel);
    channel.onopen = () => this.options.onDataChannelOpen?.(peer);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string'
        || new TextEncoder().encode(event.data).byteLength > MAX_MESSAGE_BYTES) return;
      try {
        const message: unknown = JSON.parse(event.data);
        if (!this.options.isPeerMessage(message)) return;
        if (message.senderId !== peer.peerId || message.protocol !== 1) return;
        this.options.onMessage(message, peer);
      } catch {
        this.options.onError?.(`Mensagem inválida recebida de ${peer.nickname}.`);
      }
    };
    channel.onclose = () => {
      if (this.channels.get(peer.peerId) === channel) this.channels.delete(peer.peerId);
    };
  }

  private async handleOffer(
    peerId: string,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    await this.createPeerConnection(peer, false);
    const connection = this.connections.get(peerId);
    if (!connection) return;

    await connection.setRemoteDescription(description);
    await this.flushIceCandidates(peerId, connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (connection.localDescription) {
      this.sendSignal({
        type: 'signal.answer',
        toPeerId: peerId,
        description: connection.localDescription,
      });
    }
  }

  private async handleAnswer(
    peerId: string,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    await connection.setRemoteDescription(description);
    await this.flushIceCandidates(peerId, connection);
  }

  private async handleIceCandidate(
    peerId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    const connection = this.connections.get(peerId);
    if (!connection || !connection.remoteDescription) {
      const pending = this.pendingCandidates.get(peerId) ?? [];
      pending.push(candidate);
      this.pendingCandidates.set(peerId, pending);
      return;
    }
    await connection.addIceCandidate(candidate);
  }

  private async flushIceCandidates(peerId: string, connection: RTCPeerConnection): Promise<void> {
    const candidates = this.pendingCandidates.get(peerId) ?? [];
    this.pendingCandidates.set(peerId, []);
    for (const candidate of candidates) {
      await connection.addIceCandidate(candidate);
    }
  }

  private emitPeersChange(): void {
    this.options.onPeersChange?.(this.otherParticipants);
  }

  private cleanupConnections(): void {
    for (const channel of this.channels.values()) channel.close();
    for (const connection of this.connections.values()) connection.close();
    this.channels.clear();
    this.connections.clear();
    this.pendingCandidates.clear();
    this.peers.clear();
    this.self = null;
    this.roomCode = null;
    this.snapshotProviderId = null;
    this.emitPeersChange();
  }
}
