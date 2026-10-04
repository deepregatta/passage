"""R2 transport for storage v1. Every write has exactly one SDK attempt."""

from __future__ import annotations

import os

from storage_admission import CONTROL_BYTES, KEY, CapacityDenied, number


class PreconditionFailed(RuntimeError):
    """Only a definite provider precondition failure allows coordination retry."""


def from_env():
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(connect_timeout=10, read_timeout=20, retries={"total_max_attempts": 1}),
    )
    return S3Store(client, os.environ["R2_BUCKET"])


def status(error):
    return getattr(error, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")


class S3Store:
    def __init__(self, client, bucket):
        self.client, self.bucket = client, bucket

    def get_with_etag(self, key):
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if status(exc) == 404 or code in {"NoSuchKey", "NotFound", "404"}:
                return None, None
            raise
        stream = response["Body"]
        try:
            limit = CONTROL_BYTES if key == KEY else None
            if key in {"prepared/latest.json", "prepared/previous.json"} or key.startswith(
                "prepared/pointers/"
            ):
                limit = 1_048_576
            body = stream.read(limit + 1) if limit is not None else stream.read()
            if limit is not None and len(body) > limit:
                raise CapacityDenied("oversized control or pointer")
            etag = response.get("ETag")
            if not isinstance(etag, str) or not etag:
                raise CapacityDenied("object concurrency token unavailable")
            return body, etag
        finally:
            stream.close()

    def put(self, key, data, *, content_type, cache_control, if_match=None, if_none_match=False):
        kwargs = dict(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            CacheControl=cache_control,
        )
        if if_match is not None:
            kwargs["IfMatch"] = if_match
        if if_none_match:
            kwargs["IfNoneMatch"] = "*"
        try:
            return self.client.put_object(**kwargs).get("ETag")
        except Exception as exc:
            if (if_match is not None or if_none_match) and status(exc) == 412:
                raise PreconditionFailed("conditional write conflict") from exc
            # A timeout/5xx/unknown 409 is never a definite non-write.
            raise

    def list_objects(self, prefix):
        result, keys, tokens = [], set(), set()
        token = None
        while True:
            kwargs = dict(Bucket=self.bucket, Prefix=prefix)
            if token is not None:
                kwargs["ContinuationToken"] = token
            page = self.client.list_objects_v2(**kwargs)
            if type(page.get("IsTruncated")) is not bool:
                raise CapacityDenied("object pagination unknown")
            for obj in page.get("Contents", []):
                key = obj["Key"]
                size = number(obj["Size"])
                if not isinstance(key, str) or not key.startswith(prefix) or key in keys:
                    raise CapacityDenied("object inventory inconsistent")
                keys.add(key)
                result.append({"key": key, "bytes": size, "etag": obj.get("ETag")})
            if not page["IsTruncated"]:
                return result
            token = page.get("NextContinuationToken")
            if not isinstance(token, str) or not token or token in tokens:
                raise CapacityDenied("object pagination incomplete")
            tokens.add(token)

    def multipart_bytes(self):
        total, uploads, markers = 0, set(), set()
        for page in self.client.get_paginator("list_multipart_uploads").paginate(
            Bucket=self.bucket
        ):
            if type(page.get("IsTruncated")) is not bool:
                raise CapacityDenied("multipart pagination unknown")
            if page["IsTruncated"]:
                marker = (page.get("NextKeyMarker"), page.get("NextUploadIdMarker"))
                if not all(marker) or marker in markers:
                    raise CapacityDenied("multipart pagination incomplete")
                markers.add(marker)
            for upload in page.get("Uploads", []):
                identity = (upload["Key"], upload["UploadId"])
                if not all(isinstance(v, str) and v for v in identity) or identity in uploads:
                    raise CapacityDenied("multipart inventory inconsistent")
                uploads.add(identity)
                parts_seen, part_markers = set(), set()
                for parts in self.client.get_paginator("list_parts").paginate(
                    Bucket=self.bucket, Key=identity[0], UploadId=identity[1]
                ):
                    if type(parts.get("IsTruncated")) is not bool:
                        raise CapacityDenied("part pagination unknown")
                    if parts["IsTruncated"]:
                        marker = parts.get("NextPartNumberMarker")
                        if type(marker) is not int or marker <= 0 or marker in part_markers:
                            raise CapacityDenied("part pagination incomplete")
                        part_markers.add(marker)
                    for part in parts.get("Parts", []):
                        index = number(part["PartNumber"], positive=True)
                        if index in parts_seen:
                            raise CapacityDenied("duplicate multipart part")
                        parts_seen.add(index)
                        total += number(part["Size"])
        return total
