"""Query identity and matching, independent of search subscriptions and views."""
from .store import query_key


def query_job_id(query):
    return query_key("", query)


def belongs_to(job, selection):
    if not selection:
        return False
    route = f"{(selection.get('origin') or '').strip().upper()}-{(selection.get('destination') or '').strip().upper()}"
    if job.get("route", "").upper() != route:
        return False
    start = str(selection.get("start") or "")
    end = str(selection.get("end") or start)
    if not start or not start <= job.get("depart", "") <= end:
        return False
    ret = str(selection.get("ret") or "")
    ret_end = str(selection.get("ret_end") or ret)
    job_ret = job.get("ret") or ""
    if (ret and not ret <= job_ret <= ret_end) or (not ret and job_ret):
        return False
    return (
        int(selection.get("adults") or 1), int(selection.get("children") or 0),
        int(selection.get("infants") or 0), selection.get("cabin") or "economy",
        (selection.get("currency") or "EUR").upper(),
    ) == (
        job.get("adults", 1), job.get("children", 0), job.get("infants", 0),
        job.get("cabin", "economy"), job.get("currency", "EUR"),
    )
