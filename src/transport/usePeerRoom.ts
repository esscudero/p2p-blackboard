import { useCallback, useEffect, useRef, useState } from 'react';

import {
  PeerRoom,
  type PeerConnectionState,
  type PeerEnvelopeLike,
} from './PeerRoom';
import type {
  PeerInfo,
  RoomErrorCode,
} from './signalingTypes';

export type UsePeerRoomOptions<TMessage extends PeerEnvelopeLike> = {
  signalingUrl?: string;
  isPeerMessage: (value: unknown) => value is TMessage;
  onMessage: (message: TMessage, peer: PeerInfo) => void;
};

export type PeerRoomState<TMessage extends PeerEnvelopeLike> = {
  self: PeerInfo | null;
  peers: PeerInfo[];
  openDataChannels: PeerInfo[];
  snapshotProviderId: string | null;
  connectionStates: Record<string, PeerConnectionState>;
  error: { code?: RoomErrorCode; message: string } | null;
  joining: boolean;
  joined: boolean;
  joinRoom: (roomCode: string, nickname: string) => Promise<void>;
  leaveRoom: () => void;
  sendToPeer: (peerId: string, message: TMessage) => boolean;
  broadcast: (message: TMessage) => number;
};

export function usePeerRoom<TMessage extends PeerEnvelopeLike>(
  options: UsePeerRoomOptions<TMessage>,
): PeerRoomState<TMessage> {
  const roomRef = useRef<PeerRoom<TMessage> | null>(null);
  const [self, setSelf] = useState<PeerInfo | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [openDataChannels, setOpenDataChannels] = useState<PeerInfo[]>([]);
  const [snapshotProviderId, setSnapshotProviderId] = useState<string | null>(null);
  const [connectionStates, setConnectionStates] = useState<
    Record<string, PeerConnectionState>
  >({});
  const [error, setError] = useState<{ code?: RoomErrorCode; message: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  const syncRoomState = useCallback(() => {
    const room = roomRef.current;
    setSelf(room?.participant ?? null);
    setPeers(room?.otherParticipants ?? []);
    setOpenDataChannels(room?.openDataChannels ?? []);
    setSnapshotProviderId(room?.snapshotProviderId ?? null);
  }, []);

  const joinRoom = useCallback(async (roomCode: string, nickname: string) => {
    if (roomRef.current) {
      throw new Error('Já existe uma sala ativa nesta instância.');
    }

    setJoining(true);
    setError(null);
    const signalingUrl =
      options.signalingUrl
      ?? import.meta.env.VITE_SIGNALING_URL
      ?? 'ws://localhost:3001';

    const room: PeerRoom<TMessage> = new PeerRoom<TMessage>({
      signalingUrl,
      roomCode,
      nickname,
      isPeerMessage: options.isPeerMessage,
      onMessage: options.onMessage,
      onPeersChange: () => {
        if (roomRef.current !== room) return;
        syncRoomState();
        if (!room.participant) {
          roomRef.current = null;
          setConnectionStates({});
          setJoined(false);
          setError({ message: 'A conexão com a sala foi encerrada.' });
        }
      },
      onPeerConnectionState: (peer, state) => {
        setConnectionStates((current) => ({
          ...current,
          [peer.peerId]: state,
        }));
        setOpenDataChannels(roomRef.current?.openDataChannels ?? []);
      },
      onDataChannelOpen: () => {
        setOpenDataChannels(roomRef.current?.openDataChannels ?? []);
        setSnapshotProviderId(roomRef.current?.snapshotProviderId ?? null);
      },
      onError: (message, code) => {
        setError({ code, message });
      },
    });
    roomRef.current = room;

    try {
      await room.connect();
      setSelf(room.participant);
      setPeers(room.otherParticipants);
      setOpenDataChannels(room.openDataChannels);
      setSnapshotProviderId(room.snapshotProviderId);
      setJoined(true);
    } catch (caught) {
      if (roomRef.current === room) roomRef.current = null;
      room.disconnect();
      setJoined(false);
      if (caught instanceof Error) {
        setError((current) => current ?? { message: caught.message });
      }
      throw caught;
    } finally {
      setJoining(false);
    }
  }, [options.isPeerMessage, options.onMessage, options.signalingUrl, syncRoomState]);

  const leaveRoom = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    room?.disconnect();
    setError(null);
    setSelf(null);
    setPeers([]);
    setOpenDataChannels([]);
    setSnapshotProviderId(null);
    setConnectionStates({});
    setJoined(false);
  }, []);

  const sendToPeer = useCallback((peerId: string, message: TMessage) =>
    roomRef.current?.sendToPeer(peerId, message) ?? false,
  []);

  const broadcast = useCallback((message: TMessage) =>
    roomRef.current?.broadcast(message) ?? 0,
  []);

  useEffect(() => {
    const handleBeforeUnload = () => roomRef.current?.disconnect();
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  useEffect(() => {
    syncRoomState();
  }, [syncRoomState]);

  return {
    self,
    peers,
    openDataChannels,
    snapshotProviderId,
    connectionStates,
    error,
    joining,
    joined,
    joinRoom,
    leaveRoom,
    sendToPeer,
    broadcast,
  };
}
