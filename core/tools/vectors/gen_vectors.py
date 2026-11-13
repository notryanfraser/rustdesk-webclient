#!/usr/bin/env python3
# Generates core/fixtures/crypto-vectors.json with REAL libsodium (via PyNaCl's
# nacl.bindings, which call libsodium's C functions directly). libsodium is the
# library upstream uses (sodiumoxide in hbb_common/rustdesk 1.5.3; libsodium-wrappers
# in the 1.2.5 JS client), so these are known-answer vectors for the exact
# primitives upstream calls:
# sign::sign / sign::verify -> crypto_sign (combined mode)
# box_::seal (zero nonce) -> crypto_box_easy
# secretbox::seal (counter nonce) -> crypto_secretbox_easy
# Everything is derived from fixed seeds so the output is reproducible.
#
# Run (from the repo root):
# docker run --rm -v "$PWD/core:/core" python:3.12-alpine sh -c \
# 'pip install -q pynacl==1.6.2 && python /core/tools/vectors/gen_vectors.py > /core/fixtures/crypto-vectors.json'
import hashlib
import json
import nacl
import nacl.bindings as b


def h(x: bytes) -> str:
    return x.hex()


def pb_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def idpk(id_: str, pk: bytes, kx_version: int = 0) -> bytes:
    """hbb.IdPk: id=1 (string), pk=2 (bytes), kx_version=4 (uint32, omitted when 0)."""
    i = id_.encode()
    out = b"\x0a" + pb_varint(len(i)) + i + b"\x12" + pb_varint(len(pk)) + pk
    if kx_version:
        out += b"\x20" + pb_varint(kx_version)
    return out


def seed(tag: str) -> bytes:
    # 32 deterministic bytes per tag (BLAKE2b-256 of the tag; only a seed expander)
    return hashlib.blake2b(tag.encode(), digest_size=32).digest()


PEER_ID = "496345301"

hbbs_pk, hbbs_sk = b.crypto_sign_seed_keypair(seed("hbbs-ed25519"))
peer_sign_pk, peer_sign_sk = b.crypto_sign_seed_keypair(seed("peer-ed25519"))
# The peer's per-connection box keypair (server.rs identity_handshake: box_::gen_keypair()).
peer_box_sk = seed("peer-box-sk")
peer_box_pk = b.crypto_scalarmult_base(peer_box_sk)
# The browser's ephemeral box keypair (globals.js genBoxKeyPair) and session key (genSecretKey).
eph_sk = seed("browser-ephemeral-box-sk")
eph_pk = b.crypto_scalarmult_base(eph_sk)
session_key = seed("session-key")

# hbbs RelayResponse.pk: sign(IdPk{id, pk = peer ed25519 pk}) by hbbs. No kx_version.
server_idpk = idpk(PEER_ID, peer_sign_pk)
server_signed = b.crypto_sign(server_idpk, hbbs_sk)
# SignedId.id: sign(IdPk{id, pk = box pk, kx_version = 1}) by the peer (server.rs:289-300).
peer_idpk = idpk(PEER_ID, peer_box_pk, kx_version=1)
peer_signed = b.crypto_sign(peer_idpk, peer_sign_sk)

# PublicKey.symmetric_value: box_::seal(key, zero nonce, their_pk_b, our_sk_b)
zero_nonce = bytes(24)
symmetric_value = b.crypto_box(session_key, zero_nonce, peer_box_pk, eph_sk)
# Peer side must open it (Encrypt::decode): sanity check inside the generator.
assert b.crypto_box_open(symmetric_value, zero_nonce, eph_pk, peer_box_sk) == session_key
assert b.crypto_sign_open(server_signed, hbbs_pk) == server_idpk
assert b.crypto_sign_open(peer_signed, peer_sign_pk) == peer_idpk


def counter_nonce(n: int) -> bytes:
    # hbb_common tcp.rs get_nonce: u64 little-endian in the first 8 bytes of a 24-byte nonce.
    return n.to_bytes(8, "little") + bytes(16)


secretbox = []
for counter, pt in [
    (1, b"hello"),
    (2, b""),
    (3, bytes(range(200))),
    (4294967297, b"counter above 2^32"),  # exercises bytes 4..7 of the nonce
    (1099511627779, b"counter above 2^40"),
]:
    secretbox.append(
        {
            "counter": counter,
            "nonce": h(counter_nonce(counter)),
            "plaintext": h(pt),
            "ciphertext": h(b.crypto_secretbox(pt, counter_nonce(counter), session_key)),
        }
    )

out = {
    "generator": "core/tools/vectors/gen_vectors.py",
    "pynacl": nacl.__version__,
    "peerId": PEER_ID,
    "hbbs": {"seed": h(seed("hbbs-ed25519")), "pk": h(hbbs_pk), "pkBase64": __import__("base64").b64encode(hbbs_pk).decode()},
    "peerSign": {"seed": h(seed("peer-ed25519")), "pk": h(peer_sign_pk)},
    "peerBox": {"sk": h(peer_box_sk), "pk": h(peer_box_pk)},
    "ephemeral": {"sk": h(eph_sk), "pk": h(eph_pk)},
    "sessionKey": h(session_key),
    "serverIdPk": h(server_idpk),
    "serverSignedIdPk": h(server_signed),
    "peerIdPk": h(peer_idpk),
    "peerSignedId": h(peer_signed),
    "publicKeyMessage": {"asymmetricValue": h(eph_pk), "symmetricValue": h(symmetric_value)},
    "secretbox": secretbox,
}
print(json.dumps(out, indent=2))
