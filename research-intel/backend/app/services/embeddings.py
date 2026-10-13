"""Embedding providers.

* ``hashing`` (default, offline): signed feature hashing of word uni/bi-grams, L2
  normalised. Deterministic and dependency-free, but it measures *lexical overlap*,
  not meaning. The UI and exports label it as such ("semantic similarity
  (hashing-v1 proxy)").
* ``sentence-transformers``: real dense embeddings when the optional package and
  model weights are available (install ``sentence-transformers``).
"""

import hashlib
import re
from functools import lru_cache

import numpy as np

from app.config import get_settings

TOKEN_RE = re.compile(r"[a-z0-9]+")
STOP = frozenset(
    "a an and are as at be by for from has have in is it its of on or that the this to was were with we our "
    "these those which using use used based between into than".split()
)


class HashingEmbedder:
    provider = "hashing"
    model = "hashing-v1"
    is_semantic = False

    def __init__(self, dim: int):
        self.dim = dim

    def _features(self, text: str) -> list[str]:
        toks = [t for t in TOKEN_RE.findall(text.lower()) if t not in STOP and len(t) > 1]
        return toks + [f"{a}_{b}" for a, b in zip(toks, toks[1:], strict=False)]

    def embed(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            for f in self._features(t):
                h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "little")
                out[i, h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
            n = np.linalg.norm(out[i])
            if n > 0:
                out[i] /= n
        return out


class SentenceTransformerEmbedder:
    provider = "sentence-transformers"
    is_semantic = True

    def __init__(self, model: str):
        from sentence_transformers import SentenceTransformer  # optional dependency

        self.model = model
        self._m = SentenceTransformer(model)
        self.dim = self._m.get_sentence_embedding_dimension()

    def embed(self, texts: list[str]) -> np.ndarray:
        return np.asarray(self._m.encode(texts, normalize_embeddings=True), dtype=np.float32)


@lru_cache
def get_embedder():
    s = get_settings()
    if s.embedding_provider == "sentence-transformers":
        return SentenceTransformerEmbedder(s.embedding_model)
    return HashingEmbedder(s.embedding_dim)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))
