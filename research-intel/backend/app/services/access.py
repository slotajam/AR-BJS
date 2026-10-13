"""Rights-aware evaluation of provider-reported full-text locations.

Public accessibility is *not* treated as permission or redistribution rights.
A location is fetchable only on a recorded basis:

* ``oa_license``    – the provider reports an open licence (Creative Commons / public domain)
                      for that version.
* ``oa_repository`` – a repository copy the provider flags as open access. Fetched for
                      private analysis only; never marked redistributable unless licensed.

Everything else (including "bronze" free-to-read publisher copies without a licence)
is ``access_restricted`` and is never fetched automatically.
"""

from app.services.normalize import LocationRec

OPEN_LICENSE_PREFIXES = ("cc-", "cc0", "cc by", "public-domain", "pd", "publicdomain")


def is_open_license(lic: str | None) -> bool:
    if not lic:
        return False
    v = lic.lower().strip()
    return "creativecommons.org" in v or v.startswith(OPEN_LICENSE_PREFIXES) or v == "cc0"


def evaluate(loc: LocationRec) -> dict:
    """Return access-record fields for a location."""
    base = {
        "source": loc.source,
        "url": loc.pdf_url,
        "landing_page_url": loc.landing_page_url,
        "host_type": loc.host_type,
        "version": loc.version,
        "license": loc.license,
        "permitted": False,
        "redistributable": False,
        "access_basis": "none",
    }
    if not loc.pdf_url:
        return {**base, "status": "unavailable", "error": "no_pdf_url_reported"}
    if is_open_license(loc.license):
        return {**base, "permitted": True, "redistributable": True, "access_basis": "oa_license",
                "status": "permitted_available", "error": None}
    if loc.host_type == "repository" and loc.is_oa:
        return {**base, "permitted": True, "access_basis": "oa_repository", "status": "permitted_available",
                "error": None}
    reason = "no_open_license_reported" if loc.is_oa else "not_open_access"
    return {**base, "status": "access_restricted", "error": reason}


def paper_access_status(records: list[dict]) -> str:
    if not records:
        return "unavailable"
    statuses = {r["status"] for r in records}
    if "permitted_available" in statuses:
        return "permitted_available"
    if "access_restricted" in statuses:
        return "access_restricted"
    return "unavailable"
