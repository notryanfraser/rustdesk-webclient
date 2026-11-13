// A complete in-memory hbbs + hbbr + peer for tests: real ed25519/X25519/secretbox crypto, the
// real message framing, and a scripted login conversation. Used with connectSession({connect}).
import nacl from "tweetnacl";
import {
  HashSchema,
  IdPkSchema,
  LoginResponseSchema,
  MessageSchema,
  PeerInfoSchema,
  RelayResponseSchema,
  RendezvousMessageSchema,
  SignedIdSchema,
  TransportClosedError,
  TransportTimeoutError,
  DisplayInfoSchema,
  counterNonce,
  create,
  fromBinary,
  toBinary,
  type CloseInfo,
  type ConnectFn,
  type DisplayInfo,
  type FrameTransport,
  type LoginRequest,
  type Message,
  type RendezvousMessage,
} from "../src/index.js";

export const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** One end of an in-memory socket: the code under test sees `recv/send`; the peer uses `push/onSend`. */
export class Pipe implements FrameTransport {
  readonly closed: Promise<CloseInfo>;
  private resolveClosed!: (i: CloseInfo) => void;
  info: CloseInfo | undefined;
  readonly sentRaw: Uint8Array[] = [];
  onSend: (frame: Uint8Array) => void = () => {};
  private queue: Uint8Array[] = [];
  private waiters: Array<{
    resolve: (f: Uint8Array) => void;
    reject: (e: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly errors = {
    closed: (i: CloseInfo): Error => new TransportClosedError(i),
    timeout: (ms: number): Error => new TransportTimeoutError(ms),
  };
  constructor() {
    this.closed = new Promise((r) => (this.resolveClosed = r));
  }
  push(f: Uint8Array): void {
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(f);
    } else this.queue.push(f);
  }
  send(f: Uint8Array): void {
    if (this.info) throw this.errors.closed(this.info);
    this.sentRaw.push(f);
    this.onSend(f);
  }
  recv(timeoutMs?: number): Promise<Uint8Array> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.info) return Promise.reject(this.errors.closed(this.info));
    return new Promise((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject };
      if (timeoutMs !== undefined)
        w.timer = setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(this.errors.timeout(timeoutMs));
        }, timeoutMs);
      this.waiters.push(w);
    });
  }
  close(code = 1000, reason = ""): void {
    this.remoteClose(code, reason, true);
  }
  remoteClose(code = 1006, reason = "", local = false): void {
    if (this.info) return;
    this.info = { code, reason, local };
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(this.errors.closed(this.info));
    }
    this.resolveClosed(this.info);
  }
}

export interface StubPeerOptions {
  peerId?: string;
  displays?: number;
  /** Called with each decrypted LoginRequest; `reply` sends an encrypted Message to the client. */
  onLogin?: (lr: LoginRequest, reply: (m: Message) => void) => void;
  /** Behaviour of the hbbs hop: "relay" (default) or a raw RendezvousMessage to send instead. */
  idAnswer?: RendezvousMessage;
  /**
   * What the relay does after RequestRelay: "normal" (SignedId), "silent", "close", "garbage"
   * (a non-protobuf frame), "shortBoxKey" (validly signed IdPk whose box key is 5 bytes),
   * "wrongFirstMessage" (a Hash instead of SignedId).
   */
  relay?:
    | "normal"
    | "silent"
    | "close"
    | "garbage"
    | "shortBoxKey"
    | "wrongFirstMessage";
}

export interface StubWorld {
  serverKey: string;
  peerId: string;
  connect: ConnectFn;
  /** Everything the client sent on each hop (ciphertext after the handshake). */
  idSent: Uint8Array[];
  relaySent: Uint8Array[];
  /** Send an encrypted Message to the client (after the handshake). */
  reply: (m: Message) => void;
  /** Send encrypted raw bytes (a frame that authenticates but is not a Message). */
  replyBytes: (b: Uint8Array) => void;
  /** Decrypted messages the client sent after PublicKey. */
  received: Message[];
  /** The relay-side pipe, to simulate drops. */
  relay: () => Pipe;
}

export function makeStubWorld(o: StubPeerOptions = {}): StubWorld {
  const peerId = o.peerId ?? "123456789";
  const hbbs = nacl.sign.keyPair();
  const peerSign = nacl.sign.keyPair();
  const peerBox = nacl.box.keyPair();
  const serverKey = b64(hbbs.publicKey);
  const signedIdPk = (id: string, pk: Uint8Array, key: Uint8Array) =>
    nacl.sign(toBinary(IdPkSchema, create(IdPkSchema, { id, pk })), key);

  const idPipe = new Pipe();
  const relayPipe = new Pipe();
  const world: StubWorld = {
    serverKey,
    peerId,
    idSent: idPipe.sentRaw,
    relaySent: relayPipe.sentRaw,
    received: [],
    relay: () => relayPipe,
    reply: () => {},
    replyBytes: () => {},
    connect: async (url) => (url.includes("hbbs.test") ? idPipe : relayPipe),
  };

  idPipe.onSend = () => {
    const answer: RendezvousMessage =
      o.idAnswer ??
      create(RendezvousMessageSchema, {
        union: {
          case: "relayResponse",
          value: create(RelayResponseSchema, {
            uuid: "00000000-0000-4000-8000-000000000000",
            relayServer: "hbbr.test",
            version: "1.5.3",
            union: {
              case: "pk",
              value: signedIdPk(peerId, peerSign.publicKey, hbbs.secretKey),
            },
          }),
        },
      });
    idPipe.push(toBinary(RendezvousMessageSchema, answer));
  };

  let step = 0;
  let sessionKey: Uint8Array | undefined;
  let sendCtr = 0;
  let recvCtr = 0;
  const seal = (plain: Uint8Array) =>
    nacl.secretbox(plain, counterNonce(++sendCtr), sessionKey!);
  world.reply = (m) => relayPipe.push(seal(toBinary(MessageSchema, m)));
  world.replyBytes = (bytes) => relayPipe.push(seal(bytes));

  relayPipe.onSend = (frame) => {
    step++;
    if (step === 1) {
      // RequestRelay -> the peer's SignedId
      const mode = o.relay ?? "normal";
      if (mode === "silent") return;
      if (mode === "close") return relayPipe.remoteClose(1006, "gone");
      if (mode === "garbage") return relayPipe.push(Uint8Array.of(0xff, 0xff));
      if (mode === "wrongFirstMessage")
        return relayPipe.push(
          toBinary(
            MessageSchema,
            create(MessageSchema, {
              union: {
                case: "hash",
                value: create(HashSchema, { salt: "s", challenge: "c" }),
              },
            }),
          ),
        );
      const boxPk =
        mode === "shortBoxKey" ? new Uint8Array(5) : peerBox.publicKey;
      relayPipe.push(
        toBinary(
          MessageSchema,
          create(MessageSchema, {
            union: {
              case: "signedId",
              value: create(SignedIdSchema, {
                id: signedIdPk(peerId, boxPk, peerSign.secretKey),
              }),
            },
          }),
        ),
      );
      return;
    }
    if (step === 2) {
      const m = fromBinary(MessageSchema, frame);
      if (m.union.case !== "publicKey") throw new Error("expected PublicKey");
      sessionKey = nacl.box.open(
        m.union.value.symmetricValue,
        new Uint8Array(24),
        m.union.value.asymmetricValue,
        peerBox.secretKey,
      )!;
      world.reply(
        create(MessageSchema, {
          union: {
            case: "hash",
            value: create(HashSchema, { salt: "SALT", challenge: "CHAL" }),
          },
        }),
      );
      return;
    }
    const plain = nacl.secretbox.open(
      frame,
      counterNonce(++recvCtr),
      sessionKey!,
    );
    if (!plain) throw new Error("stub peer could not decrypt");
    const m = fromBinary(MessageSchema, plain);
    world.received.push(m);
    if (m.union.case === "loginRequest") {
      (o.onLogin ?? ((_lr, reply) => reply(peerInfoResponse(o.displays ?? 1))))(
        m.union.value,
        world.reply,
      );
    }
  };
  return world;
}

export function peerInfoResponse(displays: number): Message {
  const list: DisplayInfo[] = Array.from({ length: displays }, () =>
    create(DisplayInfoSchema, { width: 1280, height: 720 }),
  );
  return create(MessageSchema, {
    union: {
      case: "loginResponse",
      value: create(LoginResponseSchema, {
        union: {
          case: "peerInfo",
          value: create(PeerInfoSchema, {
            version: "1.5.3",
            platform: "Linux",
            hostname: "stub",
            displays: list,
          }),
        },
      }),
    },
  });
}
