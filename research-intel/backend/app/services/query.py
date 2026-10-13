"""Deterministic query expansion. The original query is never modified; the
expansion is stored separately on ``Search.expanded_query`` with its version."""

import re

EXPANSION_VERSION = "deterministic-v1"


def _quote(term: str) -> str:
    term = term.strip().replace('"', "")
    return f'"{term}"' if re.search(r"\s", term) else term


def expand(
    original_query: str,
    keywords: list[str],
    synonyms: dict[str, list[str]],
    boolean_query: str | None,
    exclusion_terms: list[str],
) -> dict:
    groups: list[list[str]] = []
    if boolean_query and boolean_query.strip():
        base = boolean_query.strip()
        basis = "user_boolean_query"
    elif keywords:
        for kw in keywords:
            terms = [kw, *[s for s in synonyms.get(kw, []) if s.strip()]]
            # stable de-duplication, case-insensitive
            seen, uniq = set(), []
            for t in terms:
                if t.lower() not in seen:
                    seen.add(t.lower())
                    uniq.append(t)
            groups.append(uniq)
        parts = [
            ("(" + " OR ".join(_quote(t) for t in g) + ")") if len(g) > 1 else _quote(g[0]) for g in groups
        ]
        base = " AND ".join(parts)
        basis = "keywords_and_synonyms"
    else:
        base = original_query.strip()
        basis = "original_query"
    nots = [f"NOT {_quote(t)}" for t in exclusion_terms if t.strip()]
    text = " ".join([base, *nots]) if nots else base
    return {"version": EXPANSION_VERSION, "basis": basis, "groups": groups, "exclusions": exclusion_terms,
            "text": text, "ai_expansion": False}
