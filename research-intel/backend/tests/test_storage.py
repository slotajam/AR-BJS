import boto3
import pytest
from moto import mock_aws

from app.config import get_settings
from app.services import storage


def test_local_storage_rejects_path_traversal(tmp_path):
    s = storage.LocalStorage(str(tmp_path))
    s.put("projects/p/pdfs/x.pdf", b"%PDF-1", "application/pdf")
    assert s.get("projects/p/pdfs/x.pdf") == b"%PDF-1" and s.exists("projects/p/pdfs/x.pdf")
    with pytest.raises(ValueError):
        s.put("../../etc/passwd", b"x", "text/plain")


@mock_aws
def test_s3_storage_private_encrypted_roundtrip(monkeypatch):
    st = get_settings()
    monkeypatch.setattr(st, "s3_endpoint_url", None)
    monkeypatch.setattr(st, "s3_access_key", "testing")
    monkeypatch.setattr(st, "s3_secret_key", "testing")
    monkeypatch.setattr(st, "s3_bucket", "rip-test")
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="rip-test")
    s3 = storage.S3Storage()
    s3.put("projects/p/pdfs/a.pdf", b"%PDF-1.7 data", "application/pdf")
    assert s3.exists("projects/p/pdfs/a.pdf") and not s3.exists("nope")
    assert s3.get("projects/p/pdfs/a.pdf") == b"%PDF-1.7 data"
    head = boto3.client("s3", region_name="us-east-1").head_object(Bucket="rip-test", Key="projects/p/pdfs/a.pdf")
    assert head["ServerSideEncryption"] == "AES256"
    s3.delete("projects/p/pdfs/a.pdf")
    assert not s3.exists("projects/p/pdfs/a.pdf")
